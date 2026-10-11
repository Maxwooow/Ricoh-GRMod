// SPDX-License-Identifier: GPL-2.0-only
import { registerHooks } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
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
const { parseCube, applyCube } = await import('../../core/src/color/cube.ts');
const { gr3xFilmIcon, T6_FILM_NAMES } = await import('../../core/src/fw/gr3x/film-icons.ts');
const { sha256Hex } = await import('../../core/src/fw/container.ts');
const [official, output = 'research/gr3x/T6/fit'] = process.argv.slice(2);
if (!official) throw new Error('Usage: node fit-t6.mjs OFFICIAL.bin [output]');
const engine = await Engine.open(new Uint8Array(await readFile(official)));
const directory = resolve('examples/gr3x/T6');
const sources = JSON.parse(await readFile(resolve(directory, 'SOURCES.json'), 'utf8'));
await mkdir(output, { recursive: true });
const results = [];
const levels = Array.from({ length: 17 }, (_, i) => i / 16);
const probes = Float64Array.from(levels.flatMap(b => levels.flatMap(g => levels.flatMap(r => [r, g, b]))));
for (let i = 0; i < sources.length; i++) {
  const source = sources[i];
  if (source.name !== T6_FILM_NAMES[i]) throw new Error('Wrong T6 film order');
  const text = await readFile(resolve(directory, source.file), 'utf8');
  if (await sha256Hex(new TextEncoder().encode(text)) !== source.cube_sha256) throw new Error('Source hash changed');
  const fit = engine.convertPreset('cube', text);
  const icon = gr3xFilmIcon(engine.info.tiles.film, i);
  const record = { name: source.name, source: source.source, sourceSha256: source.cube_sha256,
    meanDE: fit.meanDE, p95DE: fit.p95DE, warnings: fit.warnings, params: { M1: fit.params.M1, ck: fit.params.ck.map(c => [...c]) },
    preset: { matrixQ13: [...fit.matrixQ13], curves: fit.curves.map(c => [...c]) },
    iconSha256: await sha256Hex(icon), hardwareTested: false };
  results.push(record);
  await writeFile(resolve(output, source.name.replaceAll(' ', '-') + '.rgba'), icon);
  // Independent RGB cube for plotting both the original and fitted software reference.
  await writeFile(resolve(output, source.name.replaceAll(' ', '-') + '-preview.json'), JSON.stringify({ size: 17,
    original: [...applyCube(parseCube(text), probes)], fitted: [...GR3X_CAMERA.slotApply(fit.params, probes)] }));
  console.log(JSON.stringify({ name: source.name, meanDE: fit.meanDE, p95DE: fit.p95DE }));
}
await writeFile(resolve(output, 'fits.json'), JSON.stringify(results, null, 2) + '\n');
