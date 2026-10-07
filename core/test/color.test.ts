import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BASE_CURVE, CAL_ADOBE, CAL_CAM, CAL_COUNT, ColorError, FullLook, S, Sinv, TONE_PARAMS, Tone,
  applyCube, convertCube, convertXmp, deltaE, fitSlot, lab, parseCube, parseXmp, previewSlot,
  quantizeSlot, slotApply,
} from '../src/color/index';
import type { SlotParams } from '../src/color/index';
import { cubeFitSamples, syntheticSamples } from '../src/color/convert';
import { _gradientCheck, robustCost } from '../src/color/fit';
import { pchipBuild, pchipEval, roundHalfEven } from '../src/color/math';
import { decodeTableText } from '../src/color/xmp';
import { curveXml, encodeTableText, escapeXml, makeLookTable, makeRgbTable, nameXml, xmpDoc } from './color-helpers/xmp-encode';

const PRIV = resolve(dirname(fileURLToPath(import.meta.url)), '../testdata/private');
const FILES = ['color_ref.json', 'q400.xmp', 'c200.xmp', 'synthetic.cube'];
const hasPrivate = FILES.every((f) => existsSync(resolve(PRIV, f)));
const read = (f: string): string => readFileSync(resolve(PRIV, f), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const J: any = hasPrivate ? JSON.parse(read('color_ref.json')) : null;

const flat = (a: number[][]): Float64Array => Float64Array.from(a.flat());
const maxAbsDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const mean = (a: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
};
const modelParams = (name: string): SlotParams => ({
  M1: J['model_' + name].M1,
  ck: J['model_' + name].ck.map((c: number[]) => Float64Array.from(c)),
});
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ColorError) return e.code;
    throw e;
  }
  return 'no error';
};

const report: string[] = [];
const note = (s: string): void => { report.push(s); };
afterAll(() => {
  if (report.length) console.log('\n[color] measured values\n  ' + report.join('\n  '));
});

const PRESETS = ['q400', 'c200'] as const;
// Non-neutral parameters these files carry that the look model ignores (see xmp.ts).
const EXPECT_UNSUPPORTED: Record<string, string[]> = { q400: [], c200: ['CurveRefineSaturation'] };

describe.skipIf(!hasPrivate)('colour pipeline against the Python reference (private data)', () => {
  it('embedded data matches the reference export', () => {
    expect(Array.from(BASE_CURVE)).toEqual(J.base_curve);
    expect(TONE_PARAMS).toEqual(J.tone_params);
    expect(CAL_COUNT).toBe(J.cal_cam.length);
    expect(maxAbsDiff(CAL_CAM, flat(J.cal_cam))).toBeLessThan(5.1e-6);
    expect(maxAbsDiff(CAL_ADOBE, flat(J.cal_adobe))).toBeLessThan(5.1e-6);
  });

  // 1 ------------------------------------------------------------------ parsing
  it.each(PRESETS)('1. parseXmp(%s) matches the decoded tables and curves', (name) => {
    const ref = J['parse_' + name];
    const look = parseXmp(read(name + '.xmp'));
    const t = look.rgbTable!;
    expect(t).not.toBeNull();
    expect(t.div).toBe(ref.div);
    expect(t.primaries).toBe(ref.primaries);
    expect(t.gamma).toBe(ref.gamma);
    expect(t.gamut).toBe(ref.gamut);
    expect(t.minAmount).toBe(ref.min_amount);
    expect(t.maxAmount).toBe(ref.max_amount);
    expect(t.lut.length).toBe(t.div ** 3 * 3);
    for (const [i, j, k, rgb] of ref.lut_samples as [number, number, number, number[]][]) {
      const o = ((i * t.div + j) * t.div + k) * 3;
      expect(maxAbsDiff(t.lut.subarray(o, o + 3), rgb)).toBeLessThan(1e-12);
    }
    expect(look.curves.master).toEqual(ref.curves.ToneCurvePV2012);
    expect(look.curves.red).toEqual(ref.curves.ToneCurvePV2012Red);
    expect(look.curves.green).toEqual(ref.curves.ToneCurvePV2012Green);
    expect(look.curves.blue).toEqual(ref.curves.ToneCurvePV2012Blue);
    expect(look.presetCurves).toBeNull();
    if (ref.looktable === null) {
      expect(look.lookTable).toBeNull();
    } else {
      const lt = look.lookTable!;
      expect([lt.hd, lt.sd, lt.vd, lt.encoding]).toEqual([ref.looktable.hd, ref.looktable.sd, ref.looktable.vd, ref.looktable.encoding]);
      expect(lt.data.length).toBe(lt.hd * lt.sd * lt.vd * 3);
      for (const [v, h, s, e] of ref.looktable.samples as [number, number, number, number[]][]) {
        const o = ((v * lt.hd + h) * lt.sd + s) * 3;
        expect(maxAbsDiff(lt.data.subarray(o, o + 3), e)).toBeLessThan(1e-6);
      }
    }
    expect(look.title.length).toBeGreaterThan(0);
    expect(look.title).not.toContain('&amp;');
    expect(look.amount).toBeNull();
  });

  // 2 ------------------------------------------------------------------ primitives
  it('2. lab, S, Sinv and the base tone curve match', () => {
    const X = flat(J.X);
    const dLab = maxAbsDiff(lab(X), flat(J.lab_X));
    const x0: number[] = J.X.map((r: number[]) => r[0]);
    const dS = maxAbsDiff(x0.map(S), J.S_X);
    const dSinv = maxAbsDiff(x0.map(Sinv), J.Sinv_X);
    const tone = new Tone(J.tone_params);
    const pre = tone.toPre(X);
    const dPre = maxAbsDiff(pre, flat(J.tone_to_pre));
    const dDisp = maxAbsDiff(tone.toDisplay(pre), flat(J.tone_to_display));
    note(`test 2 max abs diff: lab ${dLab.toExponential(2)}, S ${dS.toExponential(2)}, Sinv ${dSinv.toExponential(2)}, Tone.toPre ${dPre.toExponential(2)}, Tone.toDisplay ${dDisp.toExponential(2)}`);
    expect(dLab).toBeLessThan(1e-9);
    expect(dS).toBeLessThan(1e-12);
    expect(dSinv).toBeLessThan(1e-12);
    expect(dPre).toBeLessThan(1e-7);
    expect(dDisp).toBeLessThan(1e-7);
  });

  // 3 ------------------------------------------------------------------ looks
  it.each(PRESETS)('3. FullLook(%s) matches on the test inputs and on the calibration colours', (name) => {
    const fl = new FullLook(parseXmp(read(name + '.xmp')), J.tone_params);
    const dX = maxAbsDiff(fl.apply(flat(J.X)), flat(J['look_' + name]));
    const dT = maxAbsDiff(fl.apply(flat(J.cal_adobe)), flat(J['target_' + name]));
    note(`test 3 ${name} max abs diff: look(X) ${dX.toExponential(2)}, look(cal_adobe) ${dT.toExponential(2)}`);
    expect(dX).toBeLessThan(1e-6);
    expect(dT).toBeLessThan(1e-6);
    // the default tone is the embedded one
    expect(maxAbsDiff(new FullLook(parseXmp(read(name + '.xmp'))).apply(flat(J.X)), flat(J['look_' + name]))).toBeLessThan(1e-6);
  });

  // 4 ------------------------------------------------------------------ slot model
  it.each(PRESETS)('4. slotApply reproduces the Python slot for %s', (name) => {
    const d = maxAbsDiff(slotApply(modelParams(name), flat(J.X)), flat(J['model_' + name].slot_X));
    note(`test 4 ${name} max abs diff: slot(X) ${d.toExponential(2)}`);
    expect(d).toBeLessThan(1e-12);
    expect(maxAbsDiff(previewSlot(modelParams(name), flat(J.X)), flat(J['model_' + name].slot_X))).toBeLessThan(1e-12);
  });

  // 5 ------------------------------------------------------------------ quantisation
  it.each(PRESETS)('5. quantizeSlot gives exactly the integers flashed for %s', (name) => {
    const q = quantizeSlot(modelParams(name), J.M_STD_q13);
    const fw = J['fw_' + name];
    expect(q.matrixQ13).toBeInstanceOf(Int16Array);
    expect(Array.from(q.matrixQ13)).toEqual(fw.matrix);
    expect(Array.from(q.curves[0])).toEqual(fw.R);
    expect(Array.from(q.curves[1])).toEqual(fw.G);
    expect(Array.from(q.curves[2])).toEqual(fw.B);
    for (let r = 0; r < 3; r++) expect(q.matrixQ13[r * 3] + q.matrixQ13[r * 3 + 1] + q.matrixQ13[r * 3 + 2]).toBe(8192);
    // how far the unrounded values are from a rounding boundary (robustness of the exact match)
    const M = modelParams(name).M1;
    const std: number[] = J.M_STD_q13.map((v: number) => v / 8192);
    let margin = 0.5;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        if (i === j) continue;
        const v = (M[i][0] * std[j] + M[i][1] * std[3 + j] + M[i][2] * std[6 + j]) * 8192;
        margin = Math.min(margin, Math.abs(Math.abs(v - Math.floor(v)) - 0.5));
      }
    note(`test 5 ${name}: exact; smallest distance of an off-diagonal matrix element from a rounding boundary ${margin.toFixed(4)} LSB`);
  });

  // 6 ------------------------------------------------------------------ fit
  it.each(PRESETS)('6. convertXmp(%s) fits at least as well as the Python fit', (name) => {
    const text = read(name + '.xmp');
    convertXmp(text); // warm-up so the timing below is not dominated by JIT compilation
    const t0 = performance.now();
    const conv = convertXmp(text);
    const ms = performance.now() - t0;
    const ref = J['model_' + name];
    const P = flat(J.cal_cam);
    const s2s = deltaE(slotApply(conv.params, P), slotApply(modelParams(name), P));
    const slotMean = mean(s2s);
    note(`test 6 ${name}: meanDE ${conv.meanDE.toFixed(4)} (Python ${ref.fit_mean_dE.toFixed(4)}), p95 ${conv.p95DE.toFixed(4)} (Python ${ref.fit_p95_dE.toFixed(4)}), ` +
      `slot-to-slot dE mean ${slotMean.toFixed(4)} max ${Math.max(...s2s).toFixed(4)}, robust cost ${robustCost(conv.params, P, flat(J['target_' + name])).toFixed(3)} (Python ${ref.robust_cost.toFixed(3)}), ` +
      `convertXmp ${ms.toFixed(0)} ms, warnings [${conv.warnings}], unsupported [${conv.unsupported}]`);
    expect(conv.kind).toBe('xmp');
    expect(conv.title.length).toBeGreaterThan(0);
    expect(conv.meanDE).toBeLessThanOrEqual(ref.fit_mean_dE + 0.03);
    expect(conv.p95DE).toBeLessThanOrEqual(ref.fit_p95_dE + 0.1);
    expect(slotMean).toBeLessThan(0.5);
    expect(conv.warnings).toEqual([]);
    expect(conv.unsupported).toEqual(EXPECT_UNSUPPORTED[name]);
    expect(ms).toBeLessThan(10000);
    // shape of the result: rows sum to 1, curves monotone within 0..1, quantisable
    for (const row of conv.params.M1) expect(Math.abs(row[0] + row[1] + row[2] - 1)).toBeLessThan(1e-12);
    for (const c of conv.params.ck) {
      expect(c.length).toBe(17);
      for (let i = 0; i < 17; i++) {
        expect(c[i]).toBeGreaterThanOrEqual(0);
        expect(c[i]).toBeLessThanOrEqual(1);
        if (i) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
      }
    }
    const q = quantizeSlot(conv.params, J.M_STD_q13);
    const fw = J['fw_' + name];
    const dM = maxAbsDiff(q.matrixQ13, fw.matrix);
    const dC = Math.max(maxAbsDiff(q.curves[0], fw.R), maxAbsDiff(q.curves[1], fw.G), maxAbsDiff(q.curves[2], fw.B));
    note(`test 6 ${name}: firmware integers of the TS fit vs the flashed ones: matrix max |diff| ${dM} LSB (of 8192), curves max |diff| ${dC} LSB (of 16383)`);
    expect(dM).toBeLessThan(40);
    expect(dC).toBeLessThan(40);
  });

  it.each(PRESETS)('6b. rounding the embedded calibration pairs to 5 decimals is immaterial for %s', (name) => {
    const P = flat(J.cal_cam);
    const look = new FullLook(parseXmp(read(name + '.xmp')));
    const full = fitSlot(P, look.apply(flat(J.cal_adobe)));
    const conv = convertXmp(read(name + '.xmp'));
    const d = deltaE(slotApply(conv.params, P), slotApply(full, P));
    note(`test 6b ${name}: slot fitted on rounded vs full-precision calibration data: dE mean ${mean(d).toFixed(5)} max ${Math.max(...d).toFixed(5)}`);
    expect(mean(d)).toBeLessThan(0.01);
    expect(Math.max(...d)).toBeLessThan(0.05);
    expect(Math.abs(conv.meanDE - full.meanDE)).toBeLessThan(0.002);
  });

  it('6c. the analytic derivatives of the fit agree with finite differences', () => {
    const P = flat(J.cal_cam), T = flat(J.target_q400);
    const m = modelParams('q400');
    const p = new Float64Array(57);
    p.set([m.M1[0][1], m.M1[0][2], m.M1[1][0], m.M1[1][2], m.M1[2][0], m.M1[2][1]], 0);
    for (let c = 0; c < 3; c++) p.set(m.ck[c], 6 + 17 * c);
    for (let i = 0; i < 57; i++) p[i] += 0.01 * Math.sin(i * 12.345); // a generic point away from the optimum
    const { analytic, numeric } = _gradientCheck(P, T, p);
    let scale = 0;
    for (let i = 0; i < 57; i++) scale = Math.max(scale, Math.abs(numeric[i]));
    expect(maxAbsDiff(analytic, numeric) / scale).toBeLessThan(1e-4);
  });

  // 7 ------------------------------------------------------------------ cube
  it('7. the synthetic cube is applied and converted', () => {
    const text = read('synthetic.cube');
    const cube = parseCube(text);
    expect(cube.size3D).toBe(17);
    expect(cube.title).toBe('synthetic test');
    const d = maxAbsDiff(applyCube(cube, flat(J.X)), flat(J.cube_X));
    expect(d).toBeLessThan(1e-9);
    convertCube(text);
    const t0 = performance.now();
    const conv = convertCube(text);
    const ms = performance.now() - t0;
    note(`test 7: applyCube max abs diff ${d.toExponential(2)}; convertCube meanDE ${conv.meanDE.toFixed(4)}, p95 ${conv.p95DE.toFixed(4)} on ${cubeFitSamples().length / 3} colours, ${ms.toFixed(0)} ms`);
    expect(conv.kind).toBe('cube');
    expect(conv.title).toBe('synthetic test');
    expect(Number.isFinite(conv.meanDE) && Number.isFinite(conv.p95DE)).toBe(true);
    expect(conv.meanDE).toBeLessThan(2);
    for (const row of conv.params.M1) for (const v of row) expect(Number.isFinite(v)).toBe(true);
    for (const c of conv.params.ck) for (const v of c) expect(Number.isFinite(v)).toBe(true);
    expect(conv.warnings).toEqual([]);
    expect(conv.unsupported).toEqual([]);
    expect(convertCube(text)).toEqual(conv);
  });

  // 9 ------------------------------------------------------------------ determinism
  it.each(PRESETS)('9. convertXmp(%s) is deterministic and reports progress', (name) => {
    const text = read(name + '.xmp');
    const seen: number[] = [];
    const a = convertXmp(text, { onProgress: (f) => seen.push(f) });
    const b = convertXmp(text);
    expect(b).toEqual(a);
    expect(Array.from(b.params.ck[0])).toEqual(Array.from(a.params.ck[0]));
    expect(seen.length).toBeGreaterThan(2);
    for (let i = 0; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(0);
      expect(seen[i]).toBeLessThanOrEqual(1);
      if (i) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    expect(seen[seen.length - 1]).toBe(1);
  });
});

// ====================================================================== no private data needed

describe('cube parser', () => {
  const identity2 = ['0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'];
  const probe = Float64Array.from([0.25, 0.5, 0.75, 0, 0, 0, 1, 1, 1, 0.9, 0.1, 0.3]);

  it('reads a 2^3 identity with comments, CRLF, tabs and a BOM', () => {
    const text = '﻿# a comment\r\nTITLE "Tiny identity"\r\n\r\nLUT_3D_SIZE\t2\r\n# another\r\nDOMAIN_MIN 0 0 0\r\nDOMAIN_MAX 1.0 1.0 1.0\r\n' +
      identity2.map((l) => l.replace(/ /g, '\t')).join('\r\n') + '   # trailing comment\r\n';
    const cube = parseCube(text);
    expect(cube.title).toBe('Tiny identity');
    expect(cube.size3D).toBe(2);
    expect(cube.size1D).toBe(0);
    expect(maxAbsDiff(applyCube(cube, probe), probe)).toBeLessThan(1e-15);
  });

  it('uses red as the fastest index', () => {
    // output = (r, r, r) at every node
    const cube = parseCube('LUT_3D_SIZE 2\n' + ['0 0 0', '1 1 1', '0 0 0', '1 1 1', '0 0 0', '1 1 1', '0 0 0', '1 1 1'].join('\n'));
    expect(maxAbsDiff(applyCube(cube, Float64Array.from([0.3, 0.9, 0.6])), [0.3, 0.3, 0.3])).toBeLessThan(1e-15);
  });

  it('reads a 1D LUT and interpolates per channel', () => {
    const cube = parseCube('TITLE "one d"\nLUT_1D_SIZE 3\n0 0 1\n0.25 0.5 0.5\n1 1 0\n');
    expect(cube.size1D).toBe(3);
    expect(cube.size3D).toBe(0);
    const out = applyCube(cube, Float64Array.from([0.25, 0.75, 0.5, 0, 1, 1]));
    expect(maxAbsDiff(out, [0.125, 0.75, 0.5, 0, 1, 0])).toBeLessThan(1e-15);
  });

  it('honours DOMAIN_MAX and input ranges, and clips the output', () => {
    const scaled = parseCube('LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n' + identity2.join('\n'));
    expect(maxAbsDiff(applyCube(scaled, Float64Array.from([1, 0.5, 2])), [0.5, 0.25, 1])).toBeLessThan(1e-15);
    const ranged = parseCube('LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE 0.0 0.5\n' + identity2.join('\n'));
    expect(maxAbsDiff(applyCube(ranged, Float64Array.from([0.25, 0.5, 1])), [0.5, 1, 1])).toBeLessThan(1e-15);
    const wide = parseCube('LUT_3D_SIZE 2\n' + identity2.map((l) => l.replace(/1/g, '1.5').replace(/0/g, '-0.25')).join('\n'));
    expect(Array.from(applyCube(wide, Float64Array.from([0, 1, 0.5])))).toEqual([0, 1, 0.625]);
    const r1 = parseCube('LUT_1D_SIZE 2\nLUT_1D_INPUT_RANGE 0 4\n0 0 0\n1 1 1\n');
    expect(maxAbsDiff(applyCube(r1, Float64Array.from([1, 2, 8])), [0.25, 0.5, 1])).toBeLessThan(1e-15);
  });

  it('applies a 1D shaper before a 3D table when both are present', () => {
    const cube = parseCube('LUT_1D_SIZE 2\nLUT_3D_SIZE 2\n0 0 0\n0.5 0.5 0.5\n' + identity2.join('\n'));
    expect(maxAbsDiff(applyCube(cube, Float64Array.from([1, 0.5, 0])), [0.5, 0.25, 0])).toBeLessThan(1e-15);
  });

  it('rejects wrong value counts and non-cube text', () => {
    expect(codeOf(() => parseCube('LUT_3D_SIZE 2\n' + identity2.slice(0, 7).join('\n')))).toBe('bad-cube');
    expect(codeOf(() => parseCube('LUT_3D_SIZE 2\n' + identity2.concat(['0 0 0']).join('\n')))).toBe('bad-cube');
    expect(codeOf(() => parseCube('LUT_3D_SIZE 2\n' + identity2.slice(0, 7).concat(['1 1']).join('\n')))).toBe('bad-cube');
    expect(codeOf(() => parseCube('LUT_3D_SIZE 2\n' + identity2.slice(0, 7).concat(['1 1 x']).join('\n')))).toBe('bad-cube');
    expect(codeOf(() => parseCube('LUT_3D_SIZE 1\n0 0 0\n'))).toBe('bad-cube');
    expect(codeOf(() => parseCube('LUT_3D_SIZE two\n'))).toBe('bad-cube');
    expect(codeOf(() => parseCube('LUT_3D_SIZE 2\nDOMAIN_MAX 0 0 0\n' + identity2.join('\n')))).toBe('bad-cube');
    expect(codeOf(() => parseCube('Lorem ipsum dolor sit amet,\nconsectetur 1 2 3 adipiscing elit.\n42\n'))).toBe('not-cube');
    expect(codeOf(() => parseCube(''))).toBe('not-cube');
    expect(codeOf(() => parseCube('1 2 3\n4 5 6\n'))).toBe('not-cube');
    expect(codeOf(() => parseCube(xmpDoc({ PresetType: 'Look' })))).toBe('not-cube');
  });
});

describe('xmp parser', () => {
  const S_CURVE: [number, number][] = [[0, 0], [64, 50], [128, 128], [192, 210], [255, 255]];
  const identityTable = encodeTableText(makeRgbTable(5, (r, g, b) => [r, g, b]));
  const probe = Float64Array.from([0.2, 0.4, 0.6, 0.9, 0.5, 0.1, 0, 0, 0, 1, 1, 1, 0.5, 0.5, 0.5, 0.05, 0.6, 0.3]);

  it('rejects text that is not XMP', () => {
    expect(codeOf(() => parseXmp('this is not xml at all'))).toBe('not-xmp');
    expect(codeOf(() => parseXmp(''))).toBe('not-xmp');
    expect(codeOf(() => parseXmp('{"json": true}'))).toBe('not-xmp');
    expect(codeOf(() => parseXmp('<html><body>hello</body></html>'))).toBe('not-xmp');
    expect(codeOf(() => parseXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF'))).toBe('not-xmp');
    expect(codeOf(() => parseXmp('<a><b></a></b>'))).toBe('not-xmp');
    expect(codeOf(() => parseXmp('LUT_3D_SIZE 2\n0 0 0\n'))).toBe('not-xmp');
  });

  it('reports a preset that only points at a profile', () => {
    const look = '<crs:Look><rdf:Description crs:Name="Some Film" crs:Amount="1.000000" crs:UUID="0123456789ABCDEF0123456789ABCDEF" crs:SupportsAmount="true"/></crs:Look>';
    expect(codeOf(() => parseXmp(xmpDoc({ PresetType: 'Normal', UUID: 'FEDCBA9876543210FEDCBA9876543210' }, nameXml('Pointer') + look)))).toBe('look-profile-missing');
    // even when the preset has a tone curve of its own
    expect(codeOf(() => parseXmp(xmpDoc({ PresetType: 'Normal' }, look + curveXml('ToneCurvePV2012', S_CURVE))))).toBe('look-profile-missing');
    // a table that is referenced but not embedded
    const ref = '<crs:Look><rdf:Description crs:Name="Builtin Look" crs:UUID="00112233445566778899AABBCCDDEEFF"><crs:Parameters><rdf:Description crs:LookTable="FFEEDDCCBBAA99887766554433221100">' +
      curveXml('ToneCurvePV2012', S_CURVE) + '</rdf:Description></crs:Parameters></rdf:Description></crs:Look>';
    expect(codeOf(() => parseXmp(xmpDoc({ PresetType: 'Normal' }, ref)))).toBe('look-profile-missing');
    expect(codeOf(() => parseXmp(xmpDoc({ PresetType: 'Look', RGBTable: 'ABCDEF' })))).toBe('look-profile-missing');
  });

  it('reports files without any table or curve', () => {
    expect(codeOf(() => parseXmp(xmpDoc({ PresetType: 'Normal', Contrast2012: '+20' })))).toBe('no-table');
    expect(codeOf(() => parseXmp(xmpDoc({ PresetType: 'Normal' }, curveXml('ToneCurvePV2012', [[0, 0], [255, 255]]))))).toBe('no-table');
    expect(codeOf(() => parseXmp(xmpDoc({}, '<crs:Look><rdf:Description crs:Name=""/></crs:Look>')))).toBe('no-table');
  });

  it('converts a preset with a tone curve and lists unsupported adjustments once', () => {
    const text = xmpDoc(
      {
        PresetType: 'Normal', Contrast2012: '+20', Exposure2012: '0.00', Highlights2012: '0', Vibrance: '-5', Sharpness: '40',
        HueAdjustmentRed: '+3', HueAdjustmentOrange: '0', SaturationAdjustmentBlue: '-12', SplitToningShadowSaturation: '7', SplitToningShadowHue: '210',
        ColorGradeMidtoneSat: '4', ColorGradeGlobalLum: '0', ParametricDarks: '-8', GrainAmount: '25', ShadowTint: '0', RedHue: '2', ColorGradeBlending: '50',
      },
      nameXml('Punchy & warm') + curveXml('ToneCurvePV2012', S_CURVE) + '<crs:Contrast2012>+20</crs:Contrast2012>',
    );
    const look = parseXmp(text);
    expect(look.title).toBe('Punchy & warm');
    expect(look.rgbTable).toBeNull();
    expect(look.lookTable).toBeNull();
    expect(look.curves.master).toEqual(S_CURVE);
    expect(look.presetCurves).toBeNull();
    expect(look.warnings).toEqual([]);
    expect(look.unsupported.slice().sort()).toEqual(
      ['ColorGradeMidtoneSat', 'Contrast2012', 'GrainAmount', 'HueAdjustmentRed', 'ParametricDarks', 'RedHue', 'SaturationAdjustmentBlue', 'SplitToningShadowSaturation', 'Vibrance'].sort(),
    );
    const conv = convertXmp(text);
    expect(conv.kind).toBe('xmp');
    expect(conv.title).toBe('Punchy & warm');
    expect(conv.unsupported).toContain('Contrast2012');
    expect(conv.unsupported.filter((n) => n === 'Contrast2012').length).toBe(1);
    expect(Number.isFinite(conv.meanDE)).toBe(true);
    expect(conv.meanDE).toBeLessThan(6);
    // the curve brightens the upper mid-tones: the slot should too
    const mid = previewSlot(conv.params, Float64Array.from([0.75, 0.75, 0.75]));
    expect(mid[1]).toBeGreaterThan(0.76);
  });

  it('decodes an RGB table (with XML-escaped text) and applies it', () => {
    const raw = makeRgbTable(4, (r, g, b) => [g, b, r]);
    const text = encodeTableText(raw);
    expect(Array.from(decodeTableText(text))).toEqual(Array.from(raw));
    const doc = xmpDoc({ PresetType: 'Look', RGBTable: 'AA11', Table_AA11: text }, nameXml('Swap'));
    // the same document with the first table character written as a numeric character reference
    const viaEntity = doc.replace('crs:Table_AA11="' + escapeXml(text[0]), 'crs:Table_AA11="&#x' + text.charCodeAt(0).toString(16) + ';');
    expect(viaEntity).not.toBe(doc);
    for (const d of [doc, viaEntity]) {
      const look = parseXmp(d);
      expect(look.title).toBe('Swap');
      expect(look.rgbTable!.div).toBe(4);
      expect(look.rgbTable!.primaries).toBe('sRGB');
      expect(look.rgbTable!.gamma).toBe('sRGB');
      const out = new FullLook(look).apply(probe);
      for (let i = 0; i < probe.length; i += 3) {
        expect(Math.abs(out[i] - probe[i + 1])).toBeLessThan(2e-5);
        expect(Math.abs(out[i + 1] - probe[i + 2])).toBeLessThan(2e-5);
        expect(Math.abs(out[i + 2] - probe[i])).toBeLessThan(2e-5);
      }
    }
  });

  it('accepts a file with only a LookTable', () => {
    const grey = encodeTableText(makeLookTable(6, 2, 1, () => [0, 0, 1]));
    const look = parseXmp(xmpDoc({ PresetType: 'Look', LookTable: 'C0FFEE', Table_C0FFEE: grey }));
    expect(look.rgbTable).toBeNull();
    expect([look.lookTable!.hd, look.lookTable!.sd, look.lookTable!.vd, look.lookTable!.encoding]).toEqual([6, 2, 1, 0]);
    const out = new FullLook(look).apply(probe);
    for (let i = 0; i < out.length; i += 3) {
      expect(Math.abs(out[i] - out[i + 1])).toBeLessThan(1e-5);
      expect(Math.abs(out[i + 1] - out[i + 2])).toBeLessThan(1e-5);
    }
    // a neutral table leaves colours (almost) alone: only the tone curve round trip remains
    const same = encodeTableText(makeLookTable(36, 8, 4, () => [0, 1, 1], 1));
    const l2 = parseXmp(xmpDoc({ PresetType: 'Look', LookTable: 'C0FFEE', Table_C0FFEE: same }));
    expect(l2.lookTable!.encoding).toBe(1);
    expect(maxAbsDiff(new FullLook(l2).apply(probe), probe)).toBeLessThan(2e-3);
    // hue rotation by 120 degrees turns red into green
    const rot = encodeTableText(makeLookTable(3, 2, 2, () => [120, 1, 1]));
    const l3 = parseXmp(xmpDoc({ PresetType: 'Look', LookTable: 'C0FFEE', Table_C0FFEE: rot }));
    const o3 = new FullLook(l3).apply(Float64Array.from([0.8, 0.2, 0.2]));
    expect(o3[1]).toBeGreaterThan(o3[0] + 0.3);
    expect(o3[1]).toBeGreaterThan(o3[2] + 0.3);
  });

  it('rejects tables it cannot handle', () => {
    const proPhoto = encodeTableText(makeRgbTable(3, (r, g, b) => [r, g, b], 2, 1));
    expect(codeOf(() => parseXmp(xmpDoc({ RGBTable: 'A1', Table_A1: proPhoto })))).toBe('unsupported-table');
    const linear = encodeTableText(makeRgbTable(3, (r, g, b) => [r, g, b], 0, 0));
    expect(codeOf(() => parseXmp(xmpDoc({ RGBTable: 'A1', Table_A1: linear })))).toBe('unsupported-table');
    const oneD = encodeTableText(makeRgbTable(3, (r, g, b) => [r, g, b], 0, 1, 1, 1));
    expect(codeOf(() => parseXmp(xmpDoc({ RGBTable: 'A1', Table_A1: oneD })))).toBe('unsupported-table');
    const otherType = encodeTableText(makeRgbTable(3, (r, g, b) => [r, g, b], 0, 1, 7, 3));
    expect(codeOf(() => parseXmp(xmpDoc({ RGBTable: 'A1', Table_A1: otherType })))).toBe('unsupported-table');
    expect(codeOf(() => parseXmp(xmpDoc({ RGBTable: 'A1', Table_A1: identityTable.slice(0, 40) })))).toBe('bad-table');
    expect(codeOf(() => parseXmp(xmpDoc({ RGBTable: 'A1', Table_A1: 'not base85 éé' })))).toBe('bad-table');
    expect(codeOf(() => parseXmp(xmpDoc({ LookTable: 'A1', Table_A1: identityTable })))).toBe('unsupported-table');
  });

  it('reads a look embedded in a preset', () => {
    const inner = `<crs:Look><rdf:Description crs:Name="Film look" crs:Amount="0.800000" crs:UUID="0123456789ABCDEF0123456789ABCDEF">
      <crs:Group><rdf:Alt><rdf:li xml:lang="x-default">Profiles</rdf:li></rdf:Alt></crs:Group>
      <crs:Parameters><rdf:Description crs:Version="15.0" crs:ConvertToGrayscale="False" crs:RGBTable="AB12" crs:Table_AB12="${identityTable}" crs:Saturation="+10">
      ${curveXml('ToneCurvePV2012', S_CURVE)}${curveXml('ToneCurvePV2012Red', [[0, 0], [255, 255]])}
      </rdf:Description></crs:Parameters></rdf:Description></crs:Look>`;
    const preset = xmpDoc({ PresetType: 'Normal', UUID: 'FEDCBA9876543210FEDCBA9876543210', Exposure2012: '+0.35', Saturation: '+10' }, inner);
    const look = parseXmp(preset);
    expect(look.title).toBe('Film look'); // no crs:Name element: falls back to the look's Name attribute
    expect(look.rgbTable!.div).toBe(5);
    expect(look.curves.master).toEqual(S_CURVE);
    expect(look.presetCurves).toEqual({ master: null, red: null, green: null, blue: null });
    expect(look.amount).toBeCloseTo(0.8, 12);
    expect(look.warnings).toEqual(['amount-ignored']);
    expect(look.unsupported.slice().sort()).toEqual(['Exposure2012', 'Saturation']);
    expect(parseXmp(xmpDoc({ PresetType: 'Normal' }, nameXml('Outer name') + inner)).title).toBe('Outer name');
    // a preset curve around the embedded look is applied before the look's curve and flagged
    const both = parseXmp(xmpDoc({ PresetType: 'Normal' }, inner.replace('0.800000', '1.000000') + curveXml('ToneCurvePV2012', [[0, 0], [128, 100], [255, 255]])));
    expect(both.presetCurves!.master).toEqual([[0, 0], [128, 100], [255, 255]]);
    expect(both.warnings).toEqual(['preset-curve-approx']);
    const withPreset = new FullLook(both).apply(probe);
    const withoutPreset = new FullLook({ ...both, presetCurves: null }).apply(probe);
    expect(withPreset[13]).toBeLessThan(withoutPreset[13] - 0.02);
  });

  it('applies per-channel curves after the master curve and flags them', () => {
    const table = { PresetType: 'Look', RGBTable: 'AB12', Table_AB12: identityTable };
    const plain = parseXmp(xmpDoc(table, curveXml('ToneCurvePV2012', S_CURVE) + ['Red', 'Green', 'Blue'].map((c) => curveXml('ToneCurvePV2012' + c, [[0, 0], [255, 255]])).join('')));
    expect(plain.warnings).toEqual([]);
    const tinted = parseXmp(xmpDoc(table, curveXml('ToneCurvePV2012', S_CURVE) + curveXml('ToneCurvePV2012Blue', [[0, 0], [128, 90], [255, 255]])));
    expect(tinted.warnings).toEqual(['rgb-curves-approx']);
    const grey = Float64Array.from([0.5, 0.5, 0.5]);
    const a = new FullLook(plain).apply(grey);
    const b = new FullLook(tinted).apply(grey);
    expect(b[2]).toBeLessThan(a[2] - 0.05);
    // identity per-channel curves change nothing at all
    const none = parseXmp(xmpDoc(table, curveXml('ToneCurvePV2012', S_CURVE)));
    expect(Array.from(new FullLook(none).apply(probe))).toEqual(Array.from(new FullLook(plain).apply(probe)));
    // only per-channel curves, no table: still a valid input
    const only = parseXmp(xmpDoc({}, curveXml('ToneCurvePV2012Green', [[0, 0], [128, 150], [255, 255]])));
    expect(only.warnings).toEqual(['rgb-curves-approx']);
    expect(new FullLook(only).apply(grey)[1]).toBeGreaterThan(0.55);
  });

  it('handles the xpacket wrapper, a BOM, comments, element-form properties and odd prefixes', () => {
    const body = curveXml('ToneCurvePV2012', S_CURVE).replace(/crs:/g, 'cr:');
    const doc = `﻿<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<!-- generated -->
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <r:Description r:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format>image/x-raw</dc:format></r:Description>
  <r:Description r:about='' xmlns:cr='http://ns.adobe.com/camera-raw-settings/1.0/' cr:Texture='+15' cr:Amount="1">
   <cr:Clarity2012>-7</cr:Clarity2012>
   <cr:Name><r:Alt><r:li xml:lang="de-DE">Falsch</r:li><r:li xml:lang="x-default">Caf&#233; &lt;1&gt;</r:li></r:Alt></cr:Name>
   ${body.replace(/rdf:/g, 'r:')}
  </r:Description>
 </r:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    const look = parseXmp(doc);
    expect(look.title).toBe('Café <1>');
    expect(look.curves.master).toEqual(S_CURVE);
    expect(look.amount).toBe(1);
    expect(look.warnings).toEqual([]);
    expect(look.unsupported.slice().sort()).toEqual(['Clarity2012', 'Texture']);
  });
});

describe('camera slot helpers', () => {
  const identity: SlotParams = { M1: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], ck: [0, 1, 2].map(() => Float64Array.from({ length: 17 }, (_, i) => i / 16)) };

  it('rounds half to even like NumPy', () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4999, 2.5001, -2.5, 7].map(roundHalfEven).map((v) => v + 0)).toEqual([0, 2, 2, 0, -2, 2, 3, -2, 7]);
  });

  it('S and Sinv are inverse to each other on the curve samples', () => {
    for (let i = 0; i < 250; i += 7) expect(Math.abs(Sinv(S(i / 256)) - i / 256)).toBeLessThan(1e-12);
    expect(S(-1)).toBe(0);
    expect(Sinv(-1)).toBe(0);
    expect(S(2)).toBe(S(255 / 256));
  });

  it('the identity slot keeps colours and quantises to the Standard matrix', () => {
    const rgb = Float64Array.from([0.1, 0.5, 0.9, 0, 0, 0, 0.3, 0.3, 0.3]);
    expect(maxAbsDiff(slotApply(identity, rgb), rgb)).toBeLessThan(1e-12);
    const std = [8736, 32, -576, 224, 8288, -320, -192, 448, 7936];
    const q = quantizeSlot(identity, std);
    expect(Array.from(q.matrixQ13)).toEqual(std);
    for (const c of q.curves) {
      expect(c.length).toBe(256);
      expect(c[0]).toBe(0);
      for (let i = 1; i < 256; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
      for (let i = 0; i < 256; i++) expect(c[i]).toBe(i * 64);
    }
  });

  it('slotApply equals its scalar definition bit for bit', () => {
    const p: SlotParams = {
      M1: [[1.07, -0.09, 0.02], [0.12, 0.83, 0.05], [-0.3, 0.4, 0.9]],
      ck: [0.8, 1.0, 1.3].map((g, c) => Float64Array.from({ length: 17 }, (_, i) => (c === 2 && i > 13 ? 1 : 0.02 * c + 0.97 * Math.pow(i / 16, g)))),
    };
    const KNOT_X = Float64Array.from({ length: 17 }, (_, i) => i / 16);
    const lerp = (x: number, fp: Float64Array): number => {
      // np.interp on the uniform knot grid
      if (x >= 1) return fp[16];
      const k = Math.floor(x * 16);
      return KNOT_X[k] === x ? fp[k] : ((fp[k + 1] - fp[k]) / (KNOT_X[k + 1] - KNOT_X[k])) * (x - KNOT_X[k]) + fp[k];
    };
    const vals: number[] = [0, 1, 0.5, 1e-9, 1 - 1e-12, -0.2, 1.3];
    for (let i = 0; i < 256; i += 5) vals.push(BASE_CURVE[i] / 16383, Math.min(1, BASE_CURVE[i] / 16383 + 1e-13), i / 1024);
    let seed = 99;
    for (let i = 0; i < 3000; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; vals.push(seed / 4294967296); }
    while (vals.length % 3) vals.push(0.25);
    const rgb = Float64Array.from(vals);
    const fast = slotApply(p, rgb);
    for (let i = 0; i < rgb.length; i += 3) {
      const a = [Sinv(rgb[i]), Sinv(rgb[i + 1]), Sinv(rgb[i + 2])];
      for (let c = 0; c < 3; c++) {
        const l = a[0] * p.M1[c][0] + a[1] * p.M1[c][1] + a[2] * p.M1[c][2];
        const o = lerp(S(Math.min(1, Math.max(0, l))), p.ck[c]);
        expect(fast[i + c]).toBe(Math.min(1, Math.max(0, o)));
      }
    }
  });

  it('quantizeSlot forces row sums and monotone curves, and rejects bad input', () => {
    const p: SlotParams = {
      M1: [[1.20004, -0.10002, -0.10002], [0.3333, 0.3334, 0.3333], [0, 0, 1]],
      ck: [Float64Array.from({ length: 17 }, (_, i) => (i === 8 ? 0.2 : i / 16)), identity.ck[1], Float64Array.from({ length: 17 }, () => 1.5)],
    };
    const q = quantizeSlot(p, [8192, 0, 0, 0, 8192, 0, 0, 0, 8192]);
    for (let r = 0; r < 3; r++) expect(q.matrixQ13[r * 3] + q.matrixQ13[r * 3 + 1] + q.matrixQ13[r * 3 + 2]).toBe(8192);
    for (let i = 1; i < 256; i++) expect(q.curves[0][i]).toBeGreaterThanOrEqual(q.curves[0][i - 1]);
    expect(Math.max(...q.curves[2])).toBe(16383);
    expect(codeOf(() => quantizeSlot(p, [1, 2, 3]))).toBe('bad-input');
    expect(codeOf(() => quantizeSlot({ M1: [[9, -4, -4], [0, 1, 0], [0, 0, 1]], ck: identity.ck }, [8192, 0, 0, 0, 8192, 0, 0, 0, 8192]))).toBe('bad-input');
    expect(codeOf(() => slotApply({ M1: [[1, 0], [0, 1]], ck: identity.ck } as unknown as SlotParams, new Float64Array(3)))).toBe('bad-input');
  });

  it('pchip is shape preserving and passes through its points', () => {
    const xs = [0, 0.2, 0.5, 0.6, 1], ys = [0, 0.1, 0.1, 0.7, 1];
    const pc = pchipBuild(xs, ys);
    for (let i = 0; i < xs.length; i++) expect(Math.abs(pchipEval(pc, xs[i]) - ys[i])).toBeLessThan(1e-15);
    let prev = -1;
    for (let i = 0; i <= 1000; i++) {
      const v = pchipEval(pc, i / 1000);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-15);
      prev = v;
    }
    expect(pchipEval(pc, 0.35)).toBeCloseTo(0.1, 12); // flat segment stays flat
    expect(pchipEval(pc, -3)).toBe(0);
    expect(pchipEval(pc, 3)).toBe(1);
  });

  it('fitSlot recovers a known slot and validates its input', () => {
    const P = syntheticSamples(600, 7, 1);
    const truth: SlotParams = {
      M1: [[1.08, -0.05, -0.03], [-0.04, 1.1, -0.06], [0.02, -0.12, 1.1]],
      ck: [0.9, 1.0, 1.15].map((g) => Float64Array.from({ length: 17 }, (_, i) => Math.pow(i / 16, g))),
    };
    const fit = fitSlot(P, slotApply(truth, P));
    expect(fit.meanDE).toBeLessThan(0.05);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(Math.abs(fit.M1[i][j] - truth.M1[i][j])).toBeLessThan(0.01);
    expect(fit.iterations).toBeGreaterThan(1);
    expect(codeOf(() => fitSlot(new Float64Array(6), new Float64Array(9)))).toBe('bad-input');
    expect(codeOf(() => fitSlot(new Float64Array(0), new Float64Array(0)))).toBe('bad-input');
    expect(codeOf(() => fitSlot(Float64Array.from([0.1, NaN, 0.2]), Float64Array.from([0.1, 0.1, 0.2])))).toBe('bad-input');
  });

  it('fitSlot returns monotone curves within range even for crushed blacks and clipped whites', () => {
    const P = Float64Array.from(CAL_CAM);
    const target = Float64Array.from(CAL_ADOBE, (v) => Math.min(1, Math.max(0, (v - 0.15) / 0.7)));
    const fit = fitSlot(P, target);
    for (const c of fit.ck) {
      expect(c[0]).toBeLessThan(0.01);
      expect(c[16]).toBeGreaterThan(0.99);
      for (let i = 0; i < 17; i++) {
        expect(c[i]).toBeGreaterThanOrEqual(i ? c[i - 1] : 0);
        expect(c[i]).toBeLessThanOrEqual(1);
      }
    }
    expect(fit.meanDE).toBeLessThan(2.5);
    expect(fit.cost).toBeCloseTo(robustCost(fit, P, target), 9);
    expect(fit.iterations).toBeLessThanOrEqual(300);
    // an impossible target still terminates with finite numbers
    const odd = fitSlot(P, Float64Array.from(CAL_ADOBE, (v, i) => (i % 3 === 0 ? 1 - v : v)));
    expect(Number.isFinite(odd.meanDE) && Number.isFinite(odd.cost)).toBe(true);
    for (const row of odd.M1) for (const v of row) expect(Number.isFinite(v)).toBe(true);
  });

  it('the synthetic fitting colours are reproducible and well distributed', () => {
    const a = syntheticSamples(), b = syntheticSamples();
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe((3000 + 24 * 4 * 6) * 3);
    let sumS = 0, sumV = 0;
    for (let i = 0; i < 3000; i++) {
      const r = a[i * 3], g = a[i * 3 + 1], bl = a[i * 3 + 2];
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      expect(mn).toBeGreaterThanOrEqual(0);
      expect(mx).toBeLessThanOrEqual(1);
      sumV += mx;
      sumS += mx > 0 ? (mx - mn) / mx : 0;
    }
    expect(Math.abs(sumS / 3000 - 1.6 / 4.6)).toBeLessThan(0.02); // mean of Beta(1.6, 3.0)
    expect(Math.abs(sumV / 3000 - 2.0 / 3.6)).toBeLessThan(0.02); // mean of Beta(2.0, 1.6)
    expect(cubeFitSamples().length).toBe(CAL_CAM.length + a.length);
  });
});
