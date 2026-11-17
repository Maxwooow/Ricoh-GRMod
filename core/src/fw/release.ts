// SPDX-License-Identifier: GPL-2.0-only
/**
 * One program, several official releases.
 *
 * A GR Mod program (fw/gr4v120, fw/gr3x) is written for one release: its addresses are that
 * release's. A later release moves every function and table; apart from that, and a handful of
 * values, the program is the same. So the program is written once, and everything that depends on the
 * release goes through the program's `target` module:
 *
 *   adr(0x53dc9dfc)                      an address of the release the program is written for, as the
 *                                        address of the same thing in the release being built
 *   `b #${adrHex(0x5393aaa8)}`           the same inside assembly text
 *   adrText('bl #0x532406a4;bx lr')      every address of a string
 *   byRelease({ '1.20': a, '1.21': b })  a value that is not an address and differs (an expected
 *                                        instruction word, a size, a hash)
 *   release === '1.60'                   for code Ricoh changed between releases
 *
 * The directory of the release the program is written for has a `target.ts` that changes nothing.
 * A later release has a directory with only what differs: its own `target.ts` (the address table made
 * by tools/port from the address map) and its compiled native modules. Every other module of the
 * program is the same file, loaded again with that target: core/overlays.mjs does that for Vite and
 * Vitest (a missing file of the release's directory is the program's file), and `rootDirs` in the
 * tsconfig says the same to the type checker.
 *
 * Nothing is carried over unmapped: an address the table does not have, or a `byRelease` without the
 * release, throws when the module loads.
 */
export interface ReleaseTarget {
  /** The release being built, e.g. '1.21'. */
  readonly release: string;
  adr(address: number): number;
  /** `adr` as text: 0x and eight lower-case hex digits. */
  adrHex(address: number): string;
  /** `adr` as text with upper-case digits. */
  adrHEX(address: number): string;
  /** A string with every address in it (0x53000000..0x55ffffff, eight digits) moved. */
  adrText(text: string): string;
  byRelease<T>(values: Readonly<Record<string, T>>): T;
}

const IN_TEXT = /\b0x5[345][0-9a-fA-F]{6}(?![0-9a-fA-F])/g;
const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');

/**
 * `release`: the one being built. `releases`: every release the program is for (a `byRelease` must
 * name them all, so that a new release cannot be forgotten at one of them). `table`: the addresses of
 * the program's own release to this one's, or null for the program's own release.
 */
export function releaseTarget(release: string, releases: readonly string[], table: ReadonlyMap<number, number> | null): ReleaseTarget {
  if (!releases.includes(release)) throw new Error(`release ${release} is not one of ${releases.join(', ')}`);
  const adr = (address: number): number => {
    if (!table) return address;
    const moved = table.get(address >>> 0);
    if (moved === undefined) throw new Error(`address 0x${hex8(address)} has no place in release ${release} (tools/port: add it to the map)`);
    return moved;
  };
  return {
    release, adr,
    adrHex: (address) => '0x' + hex8(adr(address)),
    adrHEX: (address) => '0x' + hex8(adr(address)).toUpperCase(),
    adrText: (text) => text.replace(IN_TEXT, (m) => { const h = hex8(adr(parseInt(m, 16))); return '0x' + (/[A-F]/.test(m.slice(2)) ? h.toUpperCase() : h); }),
    byRelease<T>(values: Readonly<Record<string, T>>): T {
      for (const r of releases) if (!Object.prototype.hasOwnProperty.call(values, r)) throw new Error(`byRelease: no value for release ${r}`);
      for (const r of Object.keys(values)) if (!releases.includes(r)) throw new Error(`byRelease: ${r} is not a release of this program`);
      return values[release];
    },
  };
}
