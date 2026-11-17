// SPDX-License-Identifier: GPL-2.0-only
/**
 * A release's directory is its program's directory with the release's own files on top.
 *
 * core/src/fw/gr4v121 (and gr3x170, gr3x171 over gr3x in the same way) holds only what is 1.21's own (target.ts with the address table, the compiled
 * native modules). Every other module is gr4v120's file, loaded a second time so that it takes 1.21's
 * target: an import that points into gr4v121 at a file that is not there is given that path as its
 * identity and gr4v120's file as its text. See core/src/fw/release.ts.
 *
 * This plugin must be in every Vite pipeline that loads the engine: core's and ui's Vitest, ui's build
 * and its worker build (`worker.plugins`), and the root config vite-node uses for the tools. Without it
 * the import of a release's program does not resolve and the build stops, which is intended.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FW = join(dirname(fileURLToPath(import.meta.url)), 'src', 'fw');
/** release directory -> the program it is laid over (both in core/src/fw). */
export const OVERLAYS = { gr4v121: 'gr4v120', gr3x170: 'gr3x', gr3x171: 'gr3x' };

const isFile = (p) => existsSync(p) && statSync(p).isFile();
const clean = (id) => id.replace(/[?#].*$/, '');

/** For a path inside a release's directory that has no file: the program's file it stands for, or null. */
function programFile(path) {
  for (const [over, base] of Object.entries(OVERLAYS)) {
    const dir = join(FW, over);
    if (path !== dir && !path.startsWith(dir + sep)) continue;
    const file = join(FW, base, relative(dir, path));
    return isFile(file) ? file : null;
  }
  return null;
}

export function programOverlays() {
  let root = '';
  // vite-node names a module that is not on disk by its path from the project root ('/src/fw/...').
  const absolute = (p) => (p === FW || p.startsWith(FW + sep) || !root ? p : join(root, p).startsWith(FW + sep) ? join(root, p) : p);
  return {
    name: 'grmod-program-overlays',
    enforce: 'pre',
    configResolved(config) { root = config.root; },
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null;
      const from = absolute(clean(importer));
      const virtual = !isFile(from);   // a program's module under a release's path: its imports are resolved here
      const wanted = resolve(dirname(from), clean(source));
      for (const candidate of [wanted, wanted + '.ts', join(wanted, 'index.ts')]) {
        if (isFile(candidate)) return virtual ? candidate : null;   // a real file: the release's own, or shared code
        if (programFile(candidate)) return candidate;       // the program's file, under the release's path
      }
      return null;
    },
    load(id) {
      const path = absolute(clean(id));
      if (isFile(path)) return null;
      const file = programFile(path);
      if (!file) return null;
      this.addWatchFile?.(file);
      return readFileSync(file, 'utf8');
    },
  };
}
