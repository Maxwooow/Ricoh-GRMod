// SPDX-License-Identifier: GPL-2.0-only
// Confirm a saved GR Mod project reconstructs the exact released candidate.
import { registerHooks } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
registerHooks({ resolve(s, c, next) {
  try { return next(s, c); } catch (error) {
    if (s.startsWith('.') && !/\.[a-z]+$/i.test(s)) for (const ext of ['.ts', '/index.ts']) {
      try { return next(s + ext, c); } catch { /* next */ }
    }
    throw error;
  }
} });
const { Engine } = await import('../../core/src/app/engine.ts');
const { sha256Hex } = await import('../../core/src/fw/container.ts');
const [store, release, report, ...extra] = process.argv.slice(2);
if (!store || !release || !report || extra.length) throw new Error('Usage: node verify-t6-c1-project.mjs STORE RELEASE-DIR REPORT.json');
const engine = await Engine.open(new Uint8Array(await readFile(join(store, 'firmware.bin'))));
const p = JSON.parse(await readFile(join(store, 'project.json'), 'utf8'));
assert(p.model === 'GR3X_HDF' && p.soft && !p.monoUnlock);
const requests = [];
for (const [id, slot] of Object.entries(p.slots)) {
  const fit = engine.convertPreset(slot.preset.kind, await readFile(join(store, 'preset-' + id.toLowerCase()), 'utf8'));
  const icon = new Uint8Array(await readFile(join(release, 'icons', slot.names.en.replaceAll(' ', '-') + '.rgba')));
  requests.push({ slot: id, names: slot.names, icon, preset: { matrixQ13: fit.matrixQ13, curves: fit.curves } });
}
assert.equal(requests.length, 9);
const result = await engine.buildFirmware(requests, p.ratios.map(r => ({ name: r.name, ratio: r.ratio })),
  [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }], { monoUnlock: false });
const expected = await sha256Hex(new Uint8Array(await readFile(join(release, 'fwdc243b.bin'))));
assert.equal(result.sha256, expected);
await writeFile(report, JSON.stringify({ verified: true, sha256: expected, source: 'saved project CUBEs/names + checked T6 icon pixels',
  nineCubeImportsRebuildReleaseExactly: true, existingT6EngineCompatible: true, sdWritten: false, cameraTested: false }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ verified: true, sha256: expected }));
