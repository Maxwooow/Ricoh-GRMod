// SPDX-License-Identifier: GPL-2.0-only
/**
 * Compare the default .cube fit with `photoFit` on pictures the fit never saw.
 *
 * Usage (GR IV added slot, so with Standard's hue block from the firmware):
 *   node --import <ts loader> tools/photo-fit/evaluate.ts <official fwdc248b.bin> <folder of .cube> <test.f64> <masks.u8> [<folder of reference .cube>]
 *
 * test.f64: N x 3 float64 sRGB pixels of held-out photographs as the camera's Standard renders them;
 * masks.u8: one byte per pixel, bit 0 blue sky, bit 1 skin, bit 2 bright near-neutral, bit 3 warm bright.
 * A reference folder (optional) holds other .cube files with the same names, imported with the
 * default fit, for a third column (e.g. LUTs prepared by hand for the camera).
 * Reported per LUT: mean CIEDE2000 between the camera model and the LUT itself, on all pixels and
 * per mask, and the share of pixels above 3.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../../core/src/app/engine';
import { convertCube } from '../../core/src/color/convert';
import { applyCube, parseCube } from '../../core/src/color/cube';
import { slotApply, type SlotParams } from '../../core/src/color/camera';
import { deltaE2000Lab, lab } from '../../core/src/color/math';

const [fwPath, lutDir, testPath, maskPath, refDir] = process.argv.slice(2);
const f64 = (p: string) => { const b = readFileSync(p); return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8); };
const test = f64(testPath), M = readFileSync(maskPath);
const eng: any = await Engine.open(new Uint8Array(readFileSync(fwPath)));
const hueStd: number[][] = eng.standardHue();

const NAMES = ['all', 'sky', 'skin', 'bright', 'warm'] as const;
function evaluate(params: SlotParams, T: Float64Array) {
  const d = deltaE2000Lab(lab(slotApply(params, test)), T);
  const s = [0, 0, 0, 0, 0], n = [0, 0, 0, 0, 0];
  let gt3 = 0;
  for (let i = 0; i < d.length; i++) {
    s[0] += d[i]; n[0]++;
    if (d[i] > 3) gt3++;
    for (let k = 0; k < 4; k++) if (M[i] & (1 << k)) { s[k + 1] += d[i]; n[k + 1]++; }
  }
  const r: Record<string, number> = { gt3: +(100 * gt3 / d.length).toFixed(1) };
  NAMES.forEach((k, i) => { r[k] = +(s[i] / n[i]).toFixed(3); });
  return r;
}

const rows: any[] = [];
for (const f of readdirSync(lutDir).filter((f) => f.endsWith('.cube')).sort()) {
  const text = readFileSync(join(lutDir, f), 'utf8');
  const T = lab(applyCube(parseCube(text), test));
  const t0 = Date.now();
  const def = convertCube(text, { hueStd });
  const t1 = Date.now();
  const pho = convertCube(text, { hueStd, photoFit: true });
  const t2 = Date.now();
  const row: any = { lut: f.replace(/\.cube$/, ''), default: evaluate(def.params, T), photo: evaluate(pho.params, T), kept: pho.photoFitted, ms: [t1 - t0, t2 - t1] };
  if (refDir) {
    try { row.ref = evaluate(convertCube(readFileSync(join(refDir, f), 'utf8'), { hueStd }).params, T); } catch { /* no reference for this LUT */ }
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}
