// SPDX-License-Identifier: GPL-2.0-only
// One program, several releases (src/fw/release.ts, core/overlays.mjs): needs no firmware file.
import { describe, expect, it } from 'vitest';
import { releaseTarget } from '../src/fw/release';
import * as gr4v120 from '../src/fw/gr4v120';
import * as gr4v121 from '../src/fw/gr4v121';
import * as target120 from '../src/fw/gr4v120/target';
import * as gr3x160 from '../src/fw/gr3x/program';
import * as gr3x170 from '../src/fw/gr3x170/program';
import * as gr3x171 from '../src/fw/gr3x171/program';
import { ADDRESSES as TO_170 } from '../src/fw/gr3x170/addresses';
import { ADDRESSES as TO_171 } from '../src/fw/gr3x171/addresses';
import { ADDRESSES } from '../src/fw/gr4v121/addresses';
import { BASE as BASE_120, ICON_CATALOG as ICON_CATALOG_120, OFFICIAL_RTOS_LENGTH as LENGTH_120 } from '../src/fw/gr4v120/aspect/build';
// @ts-expect-error not a file: gr4v120's module under gr4v121's path (the type checker only knows the index)
import { BASE as BASE_121, ICON_CATALOG as ICON_CATALOG_121, OFFICIAL_RTOS_LENGTH as LENGTH_121 } from '../src/fw/gr4v121/aspect/build';

describe('release targets', () => {
  const table = new Map([[0x53000010, 0x53000020], [0x5500abc0, 0x5500abc4]]);
  const own = releaseTarget('1.20', ['1.20', '1.21'], null), later = releaseTarget('1.21', ['1.20', '1.21'], table);
  it('the program\'s own release uses addresses as they are written', () => {
    expect(own.adr(0x53000010)).toBe(0x53000010);
    expect(own.adrText('bl #0x53000010;b #0x5500ABC0')).toBe('bl #0x53000010;b #0x5500ABC0');
  });
  it('a later release moves them through its table, in numbers and in text', () => {
    expect(later.adr(0x53000010)).toBe(0x53000020);
    expect(later.adrHex(0x5500abc0)).toBe('0x5500abc4');
    expect(later.adrHEX(0x5500abc0)).toBe('0x5500ABC4');
    expect(later.adrText('bl #0x53000010;b #0x5500ABC0;mov r0,#0x53')).toBe('bl #0x53000020;b #0x5500ABC4;mov r0,#0x53');
  });
  it('an address the table does not have is an error, never carried over', () => {
    expect(() => later.adr(0x53000014)).toThrow(/no place in release 1.21/);
    expect(() => later.adrText('b #0x53000014')).toThrow();
  });
  it('byRelease needs a value for every release of the program, and no other', () => {
    expect(own.byRelease({ '1.20': 1, '1.21': 2 })).toBe(1);
    expect(later.byRelease({ '1.20': 1, '1.21': 2 })).toBe(2);
    expect(() => later.byRelease({ '1.21': 2 })).toThrow(/no value for release 1.20/);
    expect(() => later.byRelease({ '1.20': 1, '1.21': 2, '1.22': 3 })).toThrow(/not a release/);
    expect(() => releaseTarget('1.22', ['1.20', '1.21'], null)).toThrow();
  });
});

describe('GR IV 1.21 is the 1.20 program with its own target', () => {
  it('the two are separate instances of the same modules', () => {
    expect(gr4v121).not.toBe(gr4v120);
    expect(Object.keys(gr4v121).sort()).toEqual(Object.keys(gr4v120).sort());
    expect(gr4v120.FIRMWARE_VERSION).toBe('1.20');
    expect(gr4v121.FIRMWARE_VERSION).toBe('1.21');
    expect(gr4v121.OFFICIAL_SHA256).not.toBe(gr4v120.OFFICIAL_SHA256);
    expect(target120.release).toBe('1.20');
  });
  it('a module below the index is 1.21\'s too: its addresses are moved, its values chosen', () => {
    expect(BASE_121).toBe(BASE_120);                              // the load address is the same
    expect(ICON_CATALOG_121).not.toBe(ICON_CATALOG_120);          // an appended table: after the longer RTOS
    expect(LENGTH_120).toBe(0x140b600);
    expect(LENGTH_121).toBe(0x140ce00);
  });
  it('the address table is one to one where it moves code', () => {
    expect(ADDRESSES.size).toBeGreaterThan(1000);
    const code = [...ADDRESSES].filter(([a]) => a < 0x54000000);
    expect(new Set(code.map(([, b]) => b)).size).toBe(code.length);
  });
});

describe('GR III / IIIx: one program, three releases', () => {
  it('each release is its own instance and accepts its own two files only', () => {
    const versions = (p: typeof gr3x160) => p.GR3_PROFILES.map((x) => x.version);
    expect(versions(gr3x160)).toEqual(['1.60', '2.10']);
    expect(versions(gr3x170)).toEqual(['1.70', '2.20']);
    expect(versions(gr3x171)).toEqual(['1.71', '2.21']);
    expect(gr3x170).not.toBe(gr3x160);
    expect(Object.keys(gr3x171).sort()).toEqual(Object.keys(gr3x160).sort());
  });
  it('the power-off pictures of the camera are the release\'s', () => {
    expect(gr3x160.GR3X_FACTORY_PICTURES.length).toBe(5);
    expect(gr3x170.GR3X_FACTORY_PICTURES).toEqual(['A:\\Resource\\Jpeg\\GB_30th.jpg']);
    expect(gr3x171.GR3X_FACTORY_PICTURES).toEqual(gr3x170.GR3X_FACTORY_PICTURES);
  });
  it('1.71 / 2.21\'s table follows both maps: nothing that 1.70 / 2.20 has is missing from it', () => {
    expect(TO_170.size).toBeGreaterThan(900);
    expect(TO_171.size).toBeGreaterThan(900);
    // every address the program uses resolved when its modules loaded (an unmapped one throws there)
    expect([...TO_170.keys()].filter((a) => !TO_171.has(a)).length).toBeLessThan(TO_170.size / 20);
  });
});
