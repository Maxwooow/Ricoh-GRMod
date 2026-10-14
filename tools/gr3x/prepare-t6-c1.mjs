// SPDX-License-Identifier: GPL-2.0-only
// Data-only correction of the locally tested CineStill slot. No common firmware
// or camera colour-conversion code is changed. The original T6 source is retained.
import { registerHooks } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(s, c, next) {
  try { return next(s, c); } catch (error) {
    if (s.startsWith('.') && !/\.[a-z]+$/i.test(s)) for (const suffix of ['.ts', '/index.ts']) {
      try { return next(s + suffix, c); } catch { /* try next */ }
    }
    throw error;
  }
} });
const { Engine } = await import('../../core/src/app/engine.ts');
const { GR3X_CAMERA } = await import('../../core/src/color/gr3x-camera.ts');
const { sha256Hex } = await import('../../core/src/fw/container.ts');
const { linToSrgb, srgbToLin, lab } = await import('../../core/src/color/math.ts');
const [official, output = 'examples/gr3x/T6-C1', ...extra] = process.argv.slice(2);
if (!official || extra.length) throw new Error('Usage: node prepare-t6-c1.mjs OFFICIAL.bin [NEW-output-directory]');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const text = await readFile(resolve(root, 'examples/gr3x/T6/CineStill-800T.cube'), 'utf8');
const sourceSha256 = await sha256Hex(new TextEncoder().encode(text));
if (sourceSha256 !== '2f0a5c8e72588cbe23c65fe4306604c84cd2f69c212b78c82903181671afab44') throw new Error('Original CineStill input changed');
const engine = await Engine.open(new Uint8Array(await readFile(official)));
const before = engine.convertPreset('cube', text);
const config = { neutralBalance: 0.90, identityToeBlend: 0.08, lowToneGainEV: 0.85, cubeSize: 33 };
const ck = [new Float64Array(17), new Float64Array(17), new Float64Array(17)];
const gain = 2 ** config.lowToneGainEV;
for (let i = 0; i < 17; i++) {
  const x = i / 16;
  // Rec.709 luminance, in linear light, prevents the blue deficit in the
  // original neutral axis from making neutral walls and shadows yellow-green.
  const y = before.params.ck.reduce((sum, c, ch) => sum + [0.2126, 0.7152, 0.0722][ch] * srgbToLin(c[i]), 0);
  for (let ch = 0; ch < 3; ch++) {
    const balanced = linToSrgb((1 - config.neutralBalance) * srgbToLin(before.params.ck[ch][i]) + config.neutralBalance * y);
    const tone = (1 - config.identityToeBlend) * balanced + config.identityToeBlend * x;
    const l = srgbToLin(tone);
    // Smooth exposure lift: black and white are fixed; highlight gain decreases
    // continuously instead of clipping the brightest parts of the image.
    ck[ch][i] = i === 0 ? 0 : linToSrgb(gain * l / (1 + (gain - 1) * l));
  }
}
// Retain the source's colour-mixing character. Only its neutral-axis/tone
// behaviour is redesigned; the importer may introduce small refit differences.
const target = { M1: before.params.M1.map(r => [...r]), ck };
const n = config.cubeSize;
const grid = Float64Array.from(Array.from({ length: n }, (_, b) =>
  Array.from({ length: n }, (_, g) => Array.from({ length: n }, (_, r) => [r / (n - 1), g / (n - 1), b / (n - 1)])).flat(2)).flat());
const transformed = GR3X_CAMERA.slotApply(target, grid);
const lines = [
  '# T6-C1 local camera-output adaptation; derived from PictureFX CineStill 800T v2.0 by Marc Roovers.',
  '# Original author: https://marcrphoto.wordpress.com/2025/02/28/picturefx-cinestill-800t-v2-0-lut/',
  '# Not an official CineStill camera profile. The author source is preserved in T6.',
  '# Input: sRGB display. Neutral-axis correction and smooth tone lift for the GR IIIx port.',
  'TITLE "CineStill 800T - GR IIIx T6-C1"', `LUT_3D_SIZE ${n}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1',
];
for (let i = 0; i < transformed.length; i += 3) lines.push(Array.from(transformed.subarray(i, i + 3), v => v.toFixed(9)).join(' '));
const cube = lines.join('\n') + '\n';
const after = engine.convertPreset('cube', cube);
const axis = Float64Array.from(Array.from({ length: 101 }, (_, i) => [i / 100, i / 100, i / 100]).flat());
const oldAxis = GR3X_CAMERA.slotApply(before.params, axis), newAxis = GR3X_CAMERA.slotApply(after.params, axis);
const oldLab = lab(oldAxis), newLab = lab(newAxis);
const neutral = Array.from({ length: 101 }, (_, i) => ({
  input: i / 100, beforeRGB: Array.from(oldAxis.subarray(i * 3, i * 3 + 3)), afterRGB: Array.from(newAxis.subarray(i * 3, i * 3 + 3)),
  beforeLab: Array.from(oldLab.subarray(i * 3, i * 3 + 3)), afterLab: Array.from(newLab.subarray(i * 3, i * 3 + 3)),
}));
const serial = x => ({ ...x, params: { M1: x.params.M1, ck: x.params.ck.map(c => [...c]) }, matrixQ13: [...x.matrixQ13], curves: x.curves.map(c => [...c]) });
await mkdir(output);
const save = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
await writeFile(resolve(output, 'CineStill-800T-T6-C1.cube'), cube, { flag: 'wx' });
await save('correction.json', { schema: 1, release: 'T6-C1', sourceSha256, correctedCubeSha256: await sha256Hex(new TextEncoder().encode(cube)),
  originalAuthor: 'Marc Roovers / PictureFX', sourceUrl: 'https://marcrphoto.wordpress.com/2025/02/28/picturefx-cinestill-800t-v2-0-lut/',
  config, target: { M1: target.M1, ck: target.ck.map(c => [...c]) }, before: serial(before), after: serial(after), neutral,
  cameraColorVerified: false, basis: 'User T6 images R0001551/R0001552 have nearly equal RAW midtones but CineStill JPEG is about 0.82 EV darker. Source v2.0 deliberately has a green cast. This local derivative reduces it and lifts tones; real C1 capture remains to be tested.' });
console.log(JSON.stringify({ output: resolve(output), meanDE: after.meanDE, p95DE: after.p95DE, grey50: neutral[50], sourceSha256 }));
