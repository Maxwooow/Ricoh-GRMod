// SPDX-License-Identifier: GPL-2.0-only
/** GR IIIx 1.60 fixed-nine ADJ/menu patch set. No general-purpose UI builder.
 * Every address below was located in the exact IIIx image, not shifted from GR IV.
 * The format checks cover IIIx's 8-byte icon descriptors and 21 native text rows.
 * Camera startup, persistent storage and the physical ISP remain hardware-unverified. */
import { assembleWords, branchWord, movWord, wordsToBytes } from '../aspect/arm';
import { drawRatioIcon } from '../aspect/icon';
import { sectionsOf, sha256Hex } from '../container';
import { FirmwareError } from '../types';
import { buildGr3xExperiment } from './experimental';
import { GR3X_160, openGr3xOfficial } from './profile';
import { installGr3xImageIdentity, installGr3xDevelopAndPlayback, installGr3xAutofocus } from './image-pipeline';
import { installGr3xMetering } from './metering';
import { installGr3xLiveView } from './liveview';
import { installGr3xRawDevelopment } from './raw-development';
import { installGr3xShading } from './shading';
import { installGr3xFullFrameRaw } from './raw-full-frame';

export const GR3X_ADJ = {
  order: 0x53b5a520,
  orderSites: [0x531a0df0, 0x531a1234, 0x531a3438, 0x531b4e08,
    0x531b6bd0, 0x531b82f8, 0x53227144],
  countSites: [0x5319fea0, 0x531b3aac],
  select: 0x531a0dd8, selected: 0x531a1218, renderIcon: 0x531a3408,
  menuSelect: 0x531b6bb8, menuSelected: 0x531b82f0, renderText: 0x531b4dec,
  ratioText: 0x53292544, ratioIcon: 0x53293800,
  textRoots: 0x55002bac, textCount: 786, languages: 21,
  textBounds: [0x533966d4, 0x533970ec],
  textRootSites: [[0x533966e8, 0x533966f0], [0x533970fc, 0x53397100]],
  iconRoot: 0x550020fc, iconCount: 671,
  iconBounds: [[0x53209fb8, 3], [0x53209fec, 3], [0x5320a7cc, 1]],
  iconRootSites: [[0x53209fcc, 3], [0x5320a000, 3], [0x5320a804, 2]],
  fnCycle: 0x53227114, fnHook: 0x5322714c, fnJoin: 0x5322716c,
} as const;

const BASE = GR3X_160.rtosBase;
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], b => parseInt(b, 16));
const words = (n: readonly number[]) => wordsToBytes(n);
function utf16z(s: string): Uint8Array {
  const out = new Uint8Array((s.length + 1) * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
  return out;
}
function fail(message: string): never { throw new FirmwareError('unexpected-layout', message); }

export async function buildGr3xAdjResearch(raw: Uint8Array) {
  const geometry = await buildGr3xExperiment(raw);
  const { decoded } = await openGr3xOfficial(raw);
  const p = GR3X_160, m = GR3X_ADJ;
  const rtos = decoded.subarray(p.rtosOffset, p.rtosOffset + p.rtosLength);
  const iconSection = sectionsOf(decoded).find(s => s.name === 'ICONBIN');
  if (!iconSection) fail('Missing IIIx ICONBIN');
  const originalIcons = decoded.subarray(iconSection.offset, iconSection.offset + iconSection.size);
  const read = (address: number, size: number): Uint8Array => {
    let at = address;
    if (at >= p.ramBase && at + size <= p.ramBase + p.ramLength) at = p.ramSource + at - p.ramBase;
    if (at < BASE || at + size > BASE + rtos.length) fail(`Read outside IIIx image: ${address.toString(16)}`);
    return rtos.slice(at - BASE, at - BASE + size);
  };
  const word = (at: number) => new DataView(read(at, 4).buffer).getUint32(0, true);
  const expect = (at: number, expected: Uint8Array) => {
    if (hex(read(at, expected.length)) !== hex(expected)) fail(`IIIx ADJ guard at ${at.toString(16)}`);
  };
  expect(m.order, Uint8Array.of(0, 3));
  expect(m.ratioText, words([0xe3510000]));
  expect(m.ratioIcon, words([0xe3510000]));
  expect(m.fnHook, words([0xe5d31000, 0xe1500001]));
  // Confirm the two native 60x40 records have IIIx's {u16 width,height;u32 offset/4} layout.
  for (const id of [256, 257]) {
    const descriptor = read(word(m.iconRoot + id * 4), 8);
    const v = new DataView(descriptor.buffer);
    if (v.getUint16(0, true) !== 60 || v.getUint16(2, true) !== 40 ||
      v.getUint32(4, true) * 4 + 9600 > originalIcons.length) fail('Unexpected IIIx native ratio icon layout');
  }
  const sites = [...geometry.sites.map(s => ({ ...s, reason: 'geometry research hook' }))];
  const parts: Uint8Array[] = [unhex(geometry.append.bytes)];
  let length = parts[0].length;
  const append = (bytes: Uint8Array): number => {
    const pad = (4 - length % 4) % 4;
    if (pad) { parts.push(new Uint8Array(pad)); length += pad; }
    const address = geometry.append.address + length;
    parts.push(bytes); length += bytes.length;
    if (address + bytes.length >= p.ramBase) fail('IIIx append reaches initialized RAM');
    return address;
  };
  const code = (source: string): number => {
    const at = geometry.append.address + ((length + 3) & ~3);
    if (append(wordsToBytes(assembleWords(source, at))) !== at) fail('Assembler address changed');
    return at;
  };
  const patch = (address: number, expected: number, replacement: number, reason: string) => {
    expect(address, words([expected]));
    if (sites.some(s => s.address === address)) fail('Overlapping IIIx ADJ patch');
    sites.push({ address, expected: hex(words([expected])), replacement: hex(words([replacement])), reason });
  };
  const pair = (low: number, high: number, register: number, old: number, next: number, reason: string) => {
    patch(low, movWord(register, old & 65535), movWord(register, next & 65535), reason);
    patch(high, movWord(register, old >>> 16, true), movWord(register, next >>> 16, true), reason);
  };

  const order = append(Uint8Array.from(geometry.ratios.map(r => r.id)));
  for (const at of m.orderSites) pair(at, at + 4, 3, m.order, order, 'nine-entry native menu order');
  for (const at of m.countSites) patch(at, 0xe3a00002, 0xe3a00009, 'nine-entry native menu count');

  const additions = geometry.ratios.filter(r => r.id >= 4);
  const textIds = new Map([[0, 241], [3, 243]]);
  const iconIds = new Map([[0, 257], [3, 256]]);
  const columns = m.textCount + additions.length;
  const rows = Array.from({ length: m.languages }, (_, l) => {
    const row = new Uint8Array(columns * 4);
    row.set(read(word(m.textRoots + l * 4), m.textCount * 4));
    return row;
  });
  additions.forEach((r, i) => {
    const text = append(utf16z(r.ratio));
    const record = append(Uint8Array.from([r.ratio.length + 1, 1, 0, 0, ...words([text])]));
    const id = m.textCount + i;
    textIds.set(r.id, id);
    rows.forEach(row => new DataView(row.buffer).setUint32(id * 4, record, true));
  });
  const textRoots = append(words(rows.map(row => append(row))));
  for (const [low, high] of m.textRootSites) pair(low, high, 3, m.textRoots, textRoots, 'extended IIIx language directory');
  for (const at of m.textBounds) patch(at, movWord(3, m.textCount - 1), movWord(3, columns - 1), 'extended IIIx text bound');

  const iconCatalog = new Uint8Array((m.iconCount + additions.length) * 4);
  iconCatalog.set(read(m.iconRoot, m.iconCount * 4));
  const pixels = additions.map(r => drawRatioIcon(r.ratio));
  let iconOffset = originalIcons.length;
  additions.forEach((r, i) => {
    if (iconOffset % 4) fail('IIIx ICONBIN alignment');
    const descriptor = append(Uint8Array.from([60, 0, 40, 0, ...words([iconOffset / 4])]));
    const id = m.iconCount + i;
    new DataView(iconCatalog.buffer).setUint32(id * 4, descriptor, true);
    iconIds.set(r.id, id); iconOffset += pixels[i].length;
  });
  const iconRoot = append(iconCatalog);
  for (const [low, r] of m.iconRootSites) pair(low, low + 4, r, m.iconRoot, iconRoot, 'extended IIIx icon directory');
  for (const [at, r] of m.iconBounds) patch(at, movWord(r, m.iconCount - 1), movWord(r, m.iconCount + additions.length - 1), 'extended IIIx icon bound');
  const lookup = (ids: Map<number, number>): number => code([...ids].map(([id, value]) =>
    `cmp r1,#${id}; movweq r0,#${value}; bxeq lr;`).join('\n') + 'mov r0,#0;bx lr;');
  const ratioText = lookup(textIds), ratioIcon = lookup(iconIds);
  patch(m.ratioText, 0xe3510000, branchWord(m.ratioText, ratioText), 'ratio identity to IIIx text ID');
  patch(m.ratioIcon, 0xe3510000, branchWord(m.ratioIcon, ratioIcon), 'ratio identity to IIIx icon ID');
  // Fn cycling uses the same nine entries. It does not intercept a physical dial.
  const fnCycle = code(geometry.ratios.map((r, i) =>
    `cmp r0,#${r.id}; moveq r1,#${geometry.ratios[(i + 1) % 9].id}; beq selected;`).join('\n') +
    `mov r1,#${geometry.ratios[0].id}; selected:b #${m.fnJoin};`);
  patch(m.fnHook, 0xe5d31000, branchWord(m.fnHook, fnCycle), 'Fn cycle through the nine menu entries');
  const program = { code, patch, append, next: () => geometry.append.address + ((length + 3) & ~3) };
  const imageEntries = installGr3xImageIdentity(program);
  const developEntries = installGr3xDevelopAndPlayback(program);
  const afEntries = installGr3xAutofocus(program);
  const mapEntries = installGr3xMetering(program);
  const liveEntries = installGr3xLiveView(program);
  const rawEntries = installGr3xRawDevelopment(program);
  const shadingEntries = installGr3xShading(program);
  const fullRawEntries = installGr3xFullFrameRaw(program);
  const payload = new Uint8Array((length + 3) & ~3);
  let at = 0; for (const part of parts) { payload.set(part, at); at += part.length; }
  const iconAddition = new Uint8Array(iconOffset - originalIcons.length);
  at = 0; for (const px of pixels) { iconAddition.set(px, at); at += px.length; }
  return {
    schema: 1, kind: 'gr3x-adj-patchset' as const, profile: p.id,
    originalRtosSha256: p.rtosSha256, originalLength: p.rtosLength, base: BASE,
    sites, append: { address: geometry.append.address, bytes: hex(payload) }, geometry,
    entries: { ...geometry.entries, ratioText, ratioIcon, fnCycle, ...imageEntries, ...developEntries, ...afEntries, ...mapEntries, ...liveEntries, ...rawEntries, ...shadingEntries, ...fullRawEntries },
    catalogs: { order, textRoots, textColumns: columns, iconRoot, iconCount: m.iconCount + additions.length },
    iconAddition: { originalLength: originalIcons.length, originalSha256: await sha256Hex(originalIcons), bytes: hex(iconAddition) },
    ratios: geometry.ratios.map(r => ({ ...r, textId: textIds.get(r.id)!, iconId: iconIds.get(r.id)! })),
    firmwareGenerated: false, hardwareTested: false, rearDialPatched: false,
    blockers: ['physical update and camera startup', 'power-cycle and U-mode storage',
      'real ADJ rendering, AF/AE/ISP, JPEG/RAW capture and playback'],
  };
}
