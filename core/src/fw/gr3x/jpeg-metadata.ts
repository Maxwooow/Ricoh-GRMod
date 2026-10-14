// SPDX-License-Identifier: GPL-2.0-only
// JPEG-only UserComment. Use the writer's captured CommonProperty, never the
// live UI setting. The native DNG writer and native ImageTone enum are untouched.
import { branchWord } from '../aspect/arm';
import { sha256Hex } from '../container';
import { FirmwareError } from '../types';

export interface FilmPhotoIdentity { name: string; revision: string }
export const GR3X_JPEG_COMMENT_BYTES = 192;
export const GR3X_JPEG_METADATA = {
  createSite: 0x53601430, createOriginal: 0xebff399a,
  setter: 0x535ff9dc, setterOriginal: 0xe1a0c00d,
  addEntry: 0x535cfaa0, setData: 0x535d034c,
  capturePropertyOffset: 8, toneOffset: 0x77c,
} as const;
export function validateFilmPhotoIdentity(p: FilmPhotoIdentity): void {
  if (!p || typeof p.name !== 'string' || typeof p.revision !== 'string' ||
      !/^[\x20-\x7e]{1,64}$/.test(p.name) || !p.name.trim() || /[;=]/.test(p.name) ||
      !/^[A-Za-z0-9._-]{1,24}$/.test(p.revision))
    throw new FirmwareError('bad-edit', 'invalid photo film name/revision');
}
export async function filmPhotoComment(identity: FilmPhotoIdentity, preset: {
  matrixQ13: ArrayLike<number>; curves: readonly ArrayLike<number>[];
}) {
  validateFilmPhotoIdentity(identity);
  if (preset.matrixQ13?.length !== 9 || preset.curves?.length !== 3 ||
      Array.from(preset.matrixQ13).some(v=>!Number.isInteger(v)||v < -32768||v > 32767) ||
      preset.curves.some(c=>c?.length!==256||Array.from(c).some(v=>!Number.isInteger(v)||v < 0||v > 16383)))
    throw new FirmwareError('bad-edit','invalid photo fingerprint parameters');
  const bytes = new Uint8Array(18 + 1536), v = new DataView(bytes.buffer);
  Array.from(preset.matrixQ13).forEach((x,i)=>v.setInt16(i*2,x,true));
  preset.curves.forEach((c,ch)=>Array.from(c).forEach((x,i)=>v.setUint16(18+ch*512+i*2,x,true)));
  const parameterSha256 = await sha256Hex(bytes);
  const text = `GRMod;Film=${identity.name};Recipe=${identity.revision};Params=${parameterSha256.slice(0,16)};Build=J1`;
  const body = new TextEncoder().encode('ASCII\0\0\0'+text+'\0');
  if (body.length > GR3X_JPEG_COMMENT_BYTES) throw new FirmwareError('bad-edit','photo marker too long');
  const payload = new Uint8Array(GR3X_JPEG_COMMENT_BYTES); payload.set(body);
  return { ...identity, text, parameterSha256, payload };
}
type Installer = {
  append(bytes: Uint8Array): number;
  code(assembly: string): number;
  patch(at: number, original: number, replacement: number, reason: string): void;
};
const address = (r:number,a:number)=>`movw r${r},#${a&65535};movt r${r},#${a>>>16};`;
export async function installGr3xJpegMetadata(p: Installer, films: readonly {
  id: number; name: string; photo?: FilmPhotoIdentity;
  preset: { matrixQ13: ArrayLike<number>; curves: readonly ArrayLike<number>[] };
}[]) {
  const m = GR3X_JPEG_METADATA, size = GR3X_JPEG_COMMENT_BYTES;
  const entries = [];
  for (const film of films) {
    const data = await filmPhotoComment(film.photo ?? {name:film.name,revision:'Custom-1'}, film.preset);
    const pointer = p.append(data.payload);
    const {payload:_,...info} = data;
    entries.push({id:film.id,pointer,...info});
  }
  const nativeText = 'GRMod;Film=Native;Recipe=RICOH-1.60;Build=J1';
  const nativeBytes = new Uint8Array(size);
  nativeBytes.set(new TextEncoder().encode('ASCII\0\0\0'+nativeText+'\0'));
  const nativePointer = p.append(nativeBytes);
  // The original caller's R4 is its native IFDEntryCreator, R0 is the Exif IFD,
  // and R1 is its existing MakerNote entry. Both additions use the original
  // factory and vector owner; allocation size and directory lengths stay native.
  const create = p.code(`push {r4-r6,lr};sub sp,sp,#8;mov r6,r0;bl #${m.addEntry};
    mov r0,r4;movw r1,#0x9286;mov r2,#7;mov r3,#${size};
    mov ip,#0;str ip,[sp];ldr ip,[r4];ldr ip,[ip,#12];mov lr,pc;bx ip;
    mov r1,r0;mov r0,r6;bl #${m.addEntry};add sp,sp,#8;pop {r4-r6,pc};`);
  p.patch(m.createSite,m.createOriginal,branchWord(m.createSite,create,14,true),
    'JPEG metadata: allocate native UserComment entry');
  // Every capture overwrites the entire padded buffer, including native modes.
  // This prevents stale film names after switching controls or reusing a writer.
  const set = p.code(`push {r0-r3,ip,lr};ldrh r2,[r1,#4];movw ip,#0x9286;
    cmp r2,ip;bne native;ldrh r2,[r1,#6];cmp r2,#7;bne native;
    ldr r2,[r1,#8];cmp r2,#${size};bne native;ldr r2,[r1,#16];cmp r2,#0;beq native;
    ldr r2,[r0,#${m.capturePropertyOffset}];cmp r2,#0;beq native;ldrb r2,[r2,#${m.toneOffset}];`+
    entries.map(e=>`cmp r2,#${e.id};beq film${e.id};`).join('')+
    address(3,nativePointer)+'b copy;'+entries.map(e=>`film${e.id}:${address(3,e.pointer)}b copy;`).join('')+
    `copy:mov r0,r1;mov r1,r3;mov r2,#${size};bl #${m.setData};
    pop {r0-r3,ip,lr};mov r0,#1;bx lr;
    native:pop {r0-r3,ip,lr};mov ip,sp;b #${m.setter+4};`);
  p.patch(m.setter,m.setterOriginal,branchWord(m.setter,set),'JPEG metadata: per-capture film identity');
  return {format:'EXIF UserComment ASCII',schema:1,bytes:size,create,set,entries,nativePointer,nativeText,
    jpgOnly:true,rawWriterChanged:false,snapshotPropertyOffset:m.capturePropertyOffset,toneOffset:m.toneOffset};
}
