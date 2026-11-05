// SPDX-License-Identifier: GPL-2.0-only
/** IIIx 1.60 factory entry. IIIx uses a 32-byte keyword table and explicit
 * branches, unlike IV's 33-byte records with authorization flags. Values are
 * extracted from the verified user's firmware, not copied from the IV port. */
import { FirmwareError } from '../types';
import type { FactoryEntry } from '../factory';
import { GR3X_160, gr3xOffset } from './profile';
import type { Gr3Profile } from './profile';

export const GR3X_FACTORY = {
  format: 0x53d615d8, keyName: 0x538f2d84, key: 0x53d628a0,
  keywords: 0x538f2d94, keywordBytes: 0x740,
  projectGetter: 0x5381fe4c, productGetter: 0x5381fe9c,
  keyCompare: 0x536bf750, keywordParse: 0x536bdd80,
} as const;

export function readGr3xFactoryEntry(decoded: Uint8Array, profile: Gr3Profile = GR3X_160): FactoryEntry {
  const word = (va: number) => new DataView(decoded.buffer, decoded.byteOffset).getUint32(gr3xOffset(va), true);
  const ascii = (va: number, n: number, xor = 0) => {
    let s = ''; const at = gr3xOffset(va);
    for (let i = 0; i < n; i++) { const c = decoded[at + i] ^ xor; if (!c) break; s += String.fromCharCode(c); }
    return s;
  };
  const check = (ok: boolean, detail: string) => {
    if (!ok) throw new FirmwareError('unexpected-layout', `IIIx factory entry: ${detail}`);
  };
  check(ascii(GR3X_FACTORY.format, 32) === 'C:\\%08ld.%03ld', 'mode-set format');
  // The getters return the build's identity: movw/mov r0,#project; bx lr and movw r0,#product&0xffff; movt r0,#product>>16.
  const projectWord = profile.project === 609 ? 0xe3000261 : profile.project === 588 ? 0xe3a00f93 : 0;
  const movw = (v: number) => (0xe3000000 | ((v & 0xf000) << 4) | (v & 0xfff)) >>> 0;
  check(word(GR3X_FACTORY.projectGetter) === projectWord && word(GR3X_FACTORY.projectGetter + 4) === 0xe12fff1e, 'project getter');
  check(word(GR3X_FACTORY.productGetter) === movw(profile.product & 0xffff) && word(GR3X_FACTORY.productGetter + 4) === (0xe3400000 | (profile.product >>> 16)) >>> 0, 'product getter');
  const project = word(0x53002030), product = word(0x53002034);
  check(project === profile.project && product === profile.product, 'header/getter identity mismatch');
  const keyPath = ascii(GR3X_FACTORY.keyName, 15, 0x29);
  check(keyPath === 'C:\\DEVELOP.MOD', 'key filename');
  const keyword = ascii(GR3X_FACTORY.keywords + 0x140, 32);
  check(keyword === 'OPEN_FACTORY_DEBUG_MENU', 'factory keyword');
  // The native parser compares entry +0x140 and writes flag +4, with no
  // additional authorization branch. This is executed by factory_probe.py.
  check(word(0x536bde64) === 0xe2851d05 && word(0x536bde74) === 0xe3a00001 && word(0x536bde78) === 0xe5c40004, 'factory keyword handler');
  check(word(GR3X_FACTORY.keyCompare + 4) === 0xe30218a0 && word(GR3X_FACTORY.keyCompare + 0x14) === 0xe34513d6, 'key reference');
  const key = decoded.slice(gr3xOffset(GR3X_FACTORY.key), gr3xOffset(GR3X_FACTORY.key) + 10);
  check(key.some(b => b !== 0) && key.some(b => b !== 255), 'empty key');
  const modeSetName = `${String(product).padStart(8, '0')}.${String(project).padStart(3, '0')}`;
  const keyName = keyPath.slice(3);
  return { modeSetName, keyName, files: [
    { name: keyName, data: key },
    { name: modeSetName, data: new TextEncoder().encode(`[${keyword}]\r\n`) },
  ] };
}
