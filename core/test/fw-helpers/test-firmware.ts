// SPDX-License-Identifier: GPL-2.0-only
/**
 * The contents of the test firmware builds given to the camera (007, 011, 012, 017 ...): two Image
 * Control presets made from synthetic .cube LUTs (warm into Cinema (Yellow), cool into Cinema
 * (Green)) with digit icons and names, and four added ratios. Shared by the tests and by
 * `tools/testfw/build.ts`, so that a test can check a build against a file that went to the camera.
 */
import { Engine, fw } from '../../src';
import type { SlotEdit } from '../../src/fw';

function cube(title: string, f: (r: number, g: number, b: number) => [number, number, number]): string {
  const N = 17;
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${N}`];
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const o = f(r / (N - 1), g / (N - 1), b / (N - 1)).map((v) => Math.min(1, Math.max(0, v)));
    lines.push(o.map((v) => v.toFixed(6)).join(' '));
  }
  return lines.join('\n') + '\n';
}
const s = (x: number): number => x + 0.12 * Math.sin(2 * Math.PI * x) * -0.5 + 0; // gentle S
const WARM = (): string => cube('Warm test', (r, g, b) => {
  const y = 0.3 * r + 0.59 * g + 0.11 * b;
  const k = 0.9;
  return [0.03 + 0.95 * s(y + k * (r - y) * 1.0 + 0.03), 0.02 + 0.95 * s(y + k * (g - y)), 0.04 + 0.88 * s(y + k * (b - y) - 0.03)];
});
const COOL = (): string => cube('Cool test', (r, g, b) => {
  const y = 0.3 * r + 0.59 * g + 0.11 * b;
  const k = 0.7;
  return [0.02 + 0.94 * s(y + k * (r - y) - 0.02), 0.02 + 0.96 * s(y + k * (g - y) + 0.005), 0.05 + 0.93 * s(y + k * (b - y) + 0.04)];
});
const GLYPHS: Record<string, string[]> = {
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
};

function digitIcon(eng: Engine, ch: string): Uint8Array {
  const info = (eng as unknown as { info: { tiles: { film: Parameters<typeof fw.composeIcon>[0] } } }).info;
  const cov = new Float32Array(1600);
  const sc = 3;
  const x0 = 20 - Math.floor((5 * sc) / 2);
  const y0 = 20 - Math.floor((7 * sc) / 2) - 1;
  GLYPHS[ch].forEach((row, y) => [...row].forEach((c, x) => {
    if (c === '#') for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) cov[(y0 + y * sc + dy) * 40 + x0 + x * sc + dx] = 1;
  }));
  return fw.composeIcon(info.tiles.film, cov);
}

const NAMES: Record<string, [string, string]> = { 'zh-CN': ['暖调', '冷调'], 'zh-TW': ['暖調', '冷調'], ja: ['ウォーム', 'クール'] };

/** The two preset requests, in the form `Engine.buildFirmware` takes. */
export function testPresetRequests(eng: Engine): SlotEdit[] {
  const presets = [['CY', WARM(), '1', 'Warm Test'], ['CG', COOL(), '2', 'Cool Test']] as const;
  return presets.map(([slot, text, ch, en], i) => {
    const p = eng.convertPreset('cube', text, undefined, { post: false }); // as built for the camera tests (no post-curve matrix)
    const names: Record<string, string> = {};
    for (const lang of fw.LANGS) {
      const t = NAMES[lang]?.[i] ?? en;
      const v = eng.validateName(slot, lang, t) as { ok?: boolean; problem?: unknown };
      if (v.ok ?? !v.problem) names[lang] = t;
    }
    return { slot, preset: { matrixQ13: p.matrixQ13, curves: p.curves }, icon: digitIcon(eng, ch), names } as unknown as SlotEdit;
  });
}

/** The four added ratios (the first four candidates that fit together). */
export function testRatios(eng: Engine): { name: string; ratio: string }[] {
  const cands: [string, string][] = [['XPan', '65:24'], ['2.39:1', '2.39:1'], ['5:4', '5:4'], ['4:5', '4:5'], ['2:1', '2:1'], ['7:6', '7:6']];
  const ratios: { name: string; ratio: string }[] = [];
  for (const [name, ratio] of cands) {
    const pr = eng.previewRatio(ratio, ratios.map((r) => r.ratio));
    if (!pr.problem && ratios.length < 4) ratios.push({ name, ratio });
  }
  return ratios;
}
