// SPDX-License-Identifier: GPL-2.0-only
// Node 24+: read-only inspection and geometry planning; never writes an update file.
import { registerHooks } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (original) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      for (const suffix of ['.ts', '/index.ts']) {
        try { return next(specifier + suffix, context); } catch { /* Try the next TS form. */ }
      }
    }
    throw original;
  }
} });

const { GR3X_160, GR3X_SYMBOLS, GR3X_BLOCKERS, openGr3xOfficial } = await import('../../core/src/fw/gr3x/profile.ts');
const { GFX_RATIOS, planGr3xRatio } = await import('../../core/src/fw/gr3x/geometry.ts');
const { sectionsOf } = await import('../../core/src/fw/container.ts');
const [input, ...args] = process.argv.slice(2);
if (!input || args.length % 2 || args.some((v, i) => i % 2 === 0 && !['--report', '--rtos'].includes(v))) {
  console.error('Usage: node tools/gr3x/inspect.mjs OFFICIAL.bin [--report report.json] [--rtos extracted-rtos.bin]');
  process.exit(2);
}
const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
const paths = [input, ...Object.values(options)].map(p => resolve(p));
if (new Set(paths).size !== paths.length) throw new Error('Input, report and extraction paths must be different');
const { fw, decoded } = await openGr3xOfficial(new Uint8Array(await readFile(input)));
const report = {
  profile: GR3X_160, sections: sectionsOf(decoded), frames: fw.frames.length,
  symbols: GR3X_SYMBOLS, blockers: GR3X_BLOCKERS, hardwareTested: false, firmwareGenerated: false,
  ratios: GFX_RATIOS.map(r => GR3X_160.factoryRatios.includes(r)
    ? { requested: r, status: 'factory' } : planGr3xRatio(r)),
};
const text = JSON.stringify(report, null, 2) + '\n';
if (options['--report']) await writeFile(options['--report'], text, { flag: 'wx' });
if (options['--rtos']) await writeFile(options['--rtos'], decoded.subarray(GR3X_160.rtosOffset, GR3X_160.rtosOffset + GR3X_160.rtosLength), { flag: 'wx' });
console.log(text);
