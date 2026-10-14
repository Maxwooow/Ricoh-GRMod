// SPDX-License-Identifier: GPL-2.0-only
/** IIIx 1.60 extra still-photo Image Controls. Native IDs and banks are retained.
 * Fixed presets use private public IDs, translated at audited native consumers.
 * No shared CommonProperty mutation is used during rendering.
 */
import { assembleWords, branchWord, wordsToBytes } from '../aspect/arm';
import { FirmwareError } from '../types';
import { buildGr3xLookMenuResearch } from './image-control-research';
import type { Gr3xResearchLook } from './image-control-research';
import { GR3X_160, openGr3xOfficial } from './profile';
import { GR3X_TONE_READS } from './look-addresses';
import { quantizeSlot } from '../../color/camera';
import type { SlotParams } from '../../color/camera';
import type { QuantizedSlot } from '../../color/camera';
import { GR3X_FILM_NAMES, gr3xLookResources, validateGr3xLookName } from './look-resources';
import { gr3xLookBadge } from './look-icons';
import { installGr3xJpegMetadata } from './jpeg-metadata';
import type { FilmPhotoIdentity } from './jpeg-metadata';

export interface Gr3xFilmLook {
  name: string;
  photo?: FilmPhotoIdentity;
  params?: SlotParams;
  preset?: { matrixQ13: ArrayLike<number>; curves: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>] };
  icon?: Uint8Array;
}
export interface Gr3xLookOptions {
  /** J1: write the captured film identity into external JPEG EXIF UserComment. */
  jpegMetadata?: boolean;
  /** 1/2 reproduce T5/T5-L1; 3 provides nine independent T6 film slots. */
  displayRevision?: 1 | 2 | 3;
  /** Legacy revisions reserve two films; T6 reserves nine. Native controls stay intact. */
  films?: readonly Gr3xFilmLook[];
  monoReplicas?: boolean;
}
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16));
const addr = (r: number, a: number) => `movw r${r},#${a & 65535};movt r${r},#${a >>> 16};`;
const DEFAULTS = [
  [0x532c34e8, 0x77d], [0x532c3b54, 0x77e], [0x532c41c0, 0x77f],
  [0x532c494c, 0x780], [0x532c50d8, 0x781], [0x532c5864, 0x782],
  [0x532c5ff0, 0x784], [0x532c677c, 0x785], [0x532c6b94, 0x786],
  [0x532c6e38, 0x787], [0x532c70e4, 0x788], [0x532c7270, 0x789],
  [0x532c7520, 0x78a], [0x532c78a8, 0x78c], [0x532c7f0c, 0x78e],
  [0x532c8570, 0x790], [0x532c8bd4, 0x793], [0x532c9360, 0x794],
  [0x532c9744, 0x795], [0x532c9a20, 0x796],
] as const;
// CommonProperty 0x77d..0x796, including the native neutral filter/enum values.
const neutral = () => Uint8Array.from([
  4,4,4,4,4,4,1,4,0,1,4,0,0,0,0,0,0,0,0,0,0,4,4,4,0,0,
]);
function filmBytes(film: Gr3xFilmLook, matrix: number[]): QuantizedSlot {
  if (film.params && film.preset) throw new FirmwareError('bad-edit', 'give either fitted or quantized IIIx film data');
  const p = film.preset;
  if (!p) return quantizeSlot(film.params ?? {
    M1: [[1,0,0],[0,1,0],[0,0,1]],
    ck: [0,1,2].map(() => Float64Array.from({ length: 17 }, (_, i) => i / 16)),
  }, matrix);
  if (p.matrixQ13?.length !== 9 || p.curves?.length !== 3 ||
      Array.from(p.matrixQ13).some(v => !Number.isInteger(v) || v < -32768 || v > 32767) ||
      [0,1,2].some(r => p.matrixQ13[r*3] + p.matrixQ13[r*3+1] + p.matrixQ13[r*3+2] !== 8192) ||
      p.curves.some(c => c?.length !== 256 || Array.from(c).some((v, i, a) =>
        !Number.isInteger(v) || v < 0 || v > 16383 || (i > 0 && v < a[i-1]))))
    throw new FirmwareError('bad-edit', 'invalid IIIx matrix/RGB-curve data');
  return { matrixQ13: Int16Array.from(p.matrixQ13), curves: p.curves.map(c => Uint16Array.from(c)) as QuantizedSlot['curves'] };
}
const REPLICAS = [
  { name: 'M Standard Replica', base: 13, icon: 354, params: { 0x781: 3, 0x782: 5 } },
  { name: 'M Solid Replica', base: 15, icon: 350, params: { 0x780: 5, 0x781: 3, 0x782: 3, 0x784: 5 } },
  { name: 'M Soft Replica', base: 14, icon: 357, params: { 0x77f: 5, 0x780: 3, 0x781: 2, 0x782: 5, 0x784: 3 } },
  { name: 'M Hi BW Replica', base: 16, icon: 352, params: { 0x780: 6, 0x782: 2, 0x784: 5 } },
  { name: 'M Grainy Replica', base: 13, icon: 354, params: { 0x780: 6, 0x781: 3, 0x782: 2, 0x795: 3 } },
  { name: 'M HDR Replica', base: 20, icon: 351, params: { 0x796: 2 } },
] as const;

export async function buildGr3xImageControls(raw: Uint8Array, options: Gr3xLookOptions) {
  if (options.jpegMetadata !== undefined && typeof options.jpegMetadata !== 'boolean')
    throw new FirmwareError('bad-edit', 'invalid JPEG metadata option');
  if (options.jpegMetadata && options.displayRevision !== 3)
    throw new FirmwareError('bad-edit', 'JPEG film identity requires the nine-film recipe');
  if (options.displayRevision !== undefined && ![1, 2, 3].includes(options.displayRevision))
    throw new FirmwareError('bad-edit', 'unknown IIIx display revision');
  const displayIcons = options.displayRevision !== 1;
  const extended = options.displayRevision === 3;
  const capacity = extended ? 9 : 2;
  if ((options.films?.length ?? 0) > capacity || (extended && options.monoReplicas))
    throw new FirmwareError('bad-edit', 'T6 supports nine film slots without legacy monochrome replicas');
  const { decoded } = await openGr3xOfficial(raw);
  const resources = gr3xLookResources(decoded);
  // Reserve both film identities even when a file has not been imported, so
  // saved replica identities never shift between successive firmware builds.
  const films = Array.from({ length: capacity }, (_, i): Gr3xFilmLook => options.films?.[i] ?? { name: GR3X_FILM_NAMES[i] });
  const specs = [
    ...films.map((f, i) => ({ name: f.name, icon: f.icon ?? (displayIcons ? gr3xLookBadge(resources.tiles.film, 'F', i + 1) : undefined), source: 'cube' as const, base: 11, parameters: neutral(), film: f })),
    ...(options.monoReplicas ? REPLICAS.map((r, i) => {
      const parameters = neutral();
      for (const [offset, value] of Object.entries(r.params)) parameters[Number(offset) - 0x77d] = value;
      return { name: r.name, icon: displayIcons ? gr3xLookBadge(resources.tiles.film, 'M', i + 1) : resources.icon(r.icon), source: 'gr4m-replica' as const, base: r.base, parameters, film: undefined };
    }) : []),
  ];
  if (!specs.length) throw new FirmwareError('bad-edit', 'no IIIx extra image controls requested');
  specs.forEach(s => validateGr3xLookName(s.name));
  const menu = await buildGr3xLookMenuResearch(raw, specs as Gr3xResearchLook[], displayIcons);
  const p = GR3X_160;
  const rtos = decoded.subarray(p.rtosOffset, p.rtosOffset + p.rtosLength);
  const originalRead = (va: number, size: number) => {
    const image = va >= p.ramBase && va + size <= p.ramBase + p.ramLength ? p.ramSource + va - p.ramBase : va;
    if (image < p.rtosBase || image + size > p.rtosBase + rtos.length)
      throw new FirmwareError('bad-address', 'IIIx look read outside original image');
    return rtos.slice(image - p.rtosBase, image - p.rtosBase + size);
  };
  const u32 = (va: number) => new DataView(originalRead(va, 4).buffer).getUint32(0, true);
  const parts: Uint8Array[] = [unhex(menu.append.bytes)];
  let length = parts[0].length;
  const next = () => menu.append.address + ((length + 3) & ~3);
  const append = (bytes: Uint8Array) => {
    const pad = (-length) & 3;
    if (pad) { parts.push(new Uint8Array(pad)); length += pad; }
    const at = next();
    if (at + bytes.length >= p.ramBase) throw new FirmwareError('no-space', 'IIIx look code overlaps RAM');
    parts.push(bytes); length += bytes.length;
    return at;
  };
  const code = (s: string) => append(wordsToBytes(assembleWords(s, next())));
  const sites = menu.sites.map(s => ({ ...s }));
  const patch = (at: number, expected: number, replacement: number, reason: string) => {
    if (u32(at) !== (expected >>> 0) || sites.some(s => s.address === at))
      throw new FirmwareError('unexpected-instruction', `IIIx look guard/overlap at ${at.toString(16)}`);
    sites.push({ address: at, expected: hex(wordsToBytes([expected])), replacement: hex(wordsToBytes([replacement])), reason });
  };
  const mstd = new DataView(originalRead(u32(u32(0x55018d94 + 11 * 4) + 4), 18).buffer);
  const matrix = Array.from({ length: 9 }, (_, i) => mstd.getInt16(i * 2, true));
  const slots = specs.map((spec, i) => {
    const id = menu.addedLooks[i].id;
    let record = 0, curves = 0;
    const curveId = 0x47430000 + id;
    if (spec.film || spec.base === 20) {
      const rec = originalRead(u32(0x55018d94 + spec.base * 4), 84);
      const quantized = spec.film ? filmBytes(spec.film, matrix) : undefined;
      // HDR uses IIIx's own local-tone processing with a neutral luma matrix.
      const q = quantized?.matrixQ13 ?? Int16Array.from([2449,4809,934,2449,4809,934,2449,4809,934]);
      const bytes = new Uint8Array(18), view = new DataView(bytes.buffer);
      q.forEach((v, j) => view.setInt16(j * 2, v, true));
      new DataView(rec.buffer).setUint32(4, append(bytes), true);
      record = append(rec);
      if (quantized) {
        const bytes = new Uint8Array(1536), v = new DataView(bytes.buffer);
        quantized.curves.forEach((c, channel) => c.forEach((x, j) => v.setUint16(channel * 512 + j * 2, x, true)));
        curves = append(bytes);
      }
    }
    return { ...menu.addedLooks[i], nativeBase: spec.base, parameters: Array.from(spec.parameters),
      parameterAddress: append(spec.parameters), record, curves, curveId, renderingImplemented: true as const };
  });
  const map = (r: number) => slots.map(s => `cmp r${r},#${s.id};moveq r${r},#${s.nativeBase};`).join('');
  // Translate on read without modifying shared state, pointer provenance, flags
  // or another register. Keep these adapters specific to the audited IIIx image.
  const adapters = GR3X_TONE_READS.map(([at, word]) => {
    const dst = (word >>> 12) & 15, src = (word >>> 16) & 15;
    const scratch = [0,1,2,3].find(r => r !== dst && r !== src)!;
    const entry = code(`push {r${scratch}};mrs r${scratch},cpsr;ldrb r${dst},[r${src},#0x77c];` +
      map(dst) + `msr cpsr_f,r${scratch};pop {r${scratch}};b #${at + 4};`);
    patch(at, word, branchWord(at, entry), 'image control: native base for typed property/ISP/file consumer');
    return { address: at, entry, sourceRegister: src, destinationRegister: dst };
  });
  // The aggregate is CommonProperty[0x6c4..0x819]. Preserve the private tone ID,
  // replacing only its fixed look parameters before the original queued commit.
  const aggregate = code(`push {r0-r3,ip,lr};ldrb r2,[r6,#0xb8];` +
    slots.map(s => `cmp r2,#${s.id};beq slot${s.id};`).join('') +
    `b done;` + slots.map(s => `slot${s.id}:${addr(1, s.parameterAddress)}
      add r0,r6,#0xb9;mov r2,#26;bl #0x5313fd80;b done;`).join('') +
    `done:pop {r0-r3,ip,lr};mov r1,r6;b #0x53279a0c;`);
  patch(0x53279a08, 0xe1a01006, branchWord(0x53279a08, aggregate), 'image control: fixed preset parameters in native property transaction');
  // RAW development safely falls back to each original base. It does not
  // pretend an imported film can be reconstructed from the native EXIF enum.
  const rawEnum = code(map(1) + 'sub r1,r1,#11;b #0x53288d60;');
  patch(0x53288d5c, 0xe241100b, branchWord(0x53288d5c, rawEnum), 'image control: RAW development native-base fallback');
  const restriction = code(map(1) + 'cmp r1,#0;b #0x53553ad8;');
  patch(0x53553ad4, 0xe3510000, branchWord(0x53553ad4, restriction), 'image control: preserve native shooting-mode restrictions');
  // Native default getters assert on unknown IDs. Fixed new presets have their
  // own values; every other ID still executes the original validation.
  const defaults = DEFAULTS.map(([at, offset]) => {
    const entry = code(slots.map(s => `cmp r1,#${s.id};moveq r0,#${s.parameters[offset - 0x77d]};bxeq lr;`).join('') +
      `mov ip,sp;b #${at + 4};`);
    patch(at, 0xe1a0c00d, branchWord(at, entry), 'image control: fixed new-slot default parameter');
    return { address: at, offset, entry };
  });
  const descriptor = code(`push {r1-r3,ip};ldrb r2,[r7,#0x77c];` +
    slots.filter(s => s.record).map(s => `cmp r2,#${s.id};beq slot${s.id};`).join('') +
    `b done;` + slots.filter(s => s.record).map(s => `slot${s.id}:${addr(3, s.record)}str r3,[r4,#8];` +
      (s.nativeBase === 20 ? 'mov r3,#1;strb r3,[r4,#0x79];' : '') + 'b done;').join('') +
    'done:pop {r1-r3,ip};b #0x536f00c4;');
  patch(0x536dc690, branchWord(0x536dc690, 0x536f00c4, 14, true),
    branchWord(0x536dc690, descriptor, 14, true), 'image control: selected immutable matrix record');
  const imported = slots.filter(s => s.curves);
  const gamma = code(`cmp r2,#0;bne native;ldrb ip,[r1,#0x77c];` +
    imported.map(s => `cmp ip,#${s.id};beq slot${s.id};`).join('') +
    `native:mov ip,sp;b #0x536f0290;` +
    imported.map(s => `slot${s.id}:push {r4-r8,lr};mov r4,r0;${addr(5, s.curves)}${addr(6, s.curveId)}b copy;`).join('') +
    `copy:bl #0x536eff34;
      ldr r0,[r4];mov r1,r5;mov r2,#512;bl #0x5313fd80;
      ldr r0,[r4,#4];add r1,r5,#512;mov r2,#512;bl #0x5313fd80;
      ldr r0,[r4,#8];add r1,r5,#1024;mov r2,#512;bl #0x5313fd80;
      mov r3,#1;strb r3,[r4,#12];strb r3,[r4,#13];str r6,[r4,#20];pop {r4-r8,pc};`);
  patch(0x536f028c, 0xe1a0c00d, branchWord(0x536f028c, gamma), 'image control: per-film RGB curves and native cache identity');
  const jpegMetadata = options.jpegMetadata ? await installGr3xJpegMetadata({append,code,patch}, films.map((film,i)=>({
    id:slots[i].id,name:film.name,photo:film.photo,preset:filmBytes(film,matrix),
  }))) : undefined;
  const payload = new Uint8Array((length + 3) & ~3);
  let cursor = 0; for (const part of parts) { payload.set(part, cursor); cursor += part.length; }
  return {
    ...menu, kind: 'gr3x-image-control-patchset' as const, sites,
    ...(jpegMetadata ? {jpegMetadata} : {}),
    append: { address: menu.append.address, bytes: hex(payload) },
    addedLooks: slots, renderingImplemented: true as const,
    lookEntries: { aggregate, rawEnum, restriction, descriptor, gamma, defaults, adapters },
    // A patch-set is not a firmware update. Packaging and native regression checks
    // are separate; camera behavior remains unverified until the user tests it.
    flashable: false as const, cameraUpdateCandidate: false as const, hardwareTested: false,
    blockers: ['native look-path regression suite', 'physical camera test and persistent storage'],
    limitations: ['GR IV Monochrome-inspired replicas, not original GR IV algorithms',
      'fixed new-slot parameters', 'RAW development/EXIF use native base identities',
      'CUBE matrix/curve approximation; camera color accuracy needs sample verification'],
  };
}
