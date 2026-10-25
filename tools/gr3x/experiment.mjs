// SPDX-License-Identifier: GPL-2.0-only
// Outputs a small guarded ARM experiment manifest, not a .bin/update container.
import { registerHooks } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (original) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      for (const suffix of ['.ts', '/index.ts']) {
        try { return next(specifier + suffix, context); } catch { /* try next */ }
      }
    }
    throw original;
  }
} });
const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length || !output.endsWith('.json') || resolve(input) === resolve(output)) {
  console.error('Usage: node tools/gr3x/experiment.mjs OFFICIAL.bin NEW-experiment.json');
  process.exit(2);
}
const { buildGr3xExperiment } = await import('../../core/src/fw/gr3x/experimental.ts');
const experiment = await buildGr3xExperiment(new Uint8Array(await readFile(input)));
await writeFile(output, JSON.stringify(experiment, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output: resolve(output), appendBytes: experiment.append.bytes.length / 2,
  sites: experiment.sites.length, ratios: experiment.ratios.length, firmwareGenerated: false }));
