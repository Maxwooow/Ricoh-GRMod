// SPDX-License-Identifier: GPL-2.0-only
// IIIx-specific adaptations of the reference crop_image_identity gates.
// Native 0..3 keep their original interchange mapping. Added 4..10 carry their
// identity through the file field; all other values retain the native diagnostic.
import { branchWord, wordsToBytes } from '../aspect/arm';
import { alignedCrop, parseRatio } from '../aspect/geometry';
import type { Rect } from '../aspect/geometry';
import { GR3X_BASE_SIZES, gr3xCustoms, gr3xMaxId } from './geometry';
import type { Gr3xMenuRatio } from './geometry';
import { gr3xImm } from './experimental';

export interface Gr3xProgram {
  code(source: string): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  append(bytes: Uint8Array): number;
  next(): number;
  /** The ratio menu being built: native entries and the added ratios (identities 4..). */
  menu: readonly Gr3xMenuRatio[];
}

export const IMAGE_IDENTITY = {
  write: 0x53604a44, writeGate: 0x53604a60, fieldWriter: 0x535d02b4,
  read: 0x535ed438, readGate: 0x535ed458, fieldReader: 0x535d04bc,
  sourceAspect: 0x7b6,
} as const;

export function installGr3xImageIdentity(p: Gr3xProgram) {
  const max = gr3xMaxId(p.menu);
  const write = p.code(`
    cmp r3,#4; blo native; cmp r3,#${max}; bhi native
    mov r2,r3; b #0x53604a80
    native: cmp r3,#3; b #0x53604a64
  `);
  const read = p.code(`
    cmp r0,#4; blo native; cmp r0,#${max}; bhi native
    ldr r2,[r4,#12]; strb r0,[r2,#0x7b6]; b #0x535ed480
    native: cmp r0,#3; b #0x535ed45c
  `);
  p.patch(IMAGE_IDENTITY.writeGate, 0xe3530003, branchWord(IMAGE_IDENTITY.writeGate, write), 'photo: preserve custom aspect on write');
  p.patch(IMAGE_IDENTITY.readGate, 0xe3500003, branchWord(IMAGE_IDENTITY.readGate, read), 'photo: preserve custom aspect on read');
  const playback = p.code(`
    ldrb ip,[r8,#0x7b6]; cmp ip,#4; blo classifier; cmp ip,#${max}; movls sl,ip; bls custom
    classifier: cmp sl,#4; blo native; cmp sl,#${max}; bhi native
    custom: mov ip,sl; b #0x534c2050
    native: cmp sl,#3; b #0x534c2034
  `);
  p.patch(0x534c2030, 0xe35a0003, branchWord(0x534c2030, playback), 'playback: prefer the aspect recorded in the photo');
  const classify = p.code(`
    ldrb r1,[r7,#0x7b6]; cmp r1,#4; blo native; cmp r1,#${max}; movls r0,r1; bxls lr
    native: b #0x534d2954
  `);
  p.patch(0x534d59a8, branchWord(0x534d59a8, 0x534d2954, 14, true), branchWord(0x534d59a8, classify, 14, true), 'playback: preserve photo identity during size classification');
  const aspect = p.code(`
    cmp r0,#4; blo native; cmp r0,#${max}; bls #0x534d2988
    native: cmp r0,#3; b #0x534d296c
  `);
  p.patch(0x534d2968, 0xe3500003, branchWord(0x534d2968, aspect), 'playback: pass through known custom identities');
  return { imageWrite: write, imageRead: read, playbackIdentity: playback, sourceClassify: classify };
}

const addr = (reg: string, value: number) => `movw ${reg},#${value & 65535};movt ${reg},#${value >>> 16};`;
function customsOf(menu: readonly Gr3xMenuRatio[]) {
  return gr3xCustoms(menu).map(({ id, ratio, n, d }) => {
    const parsed = parseRatio(ratio);
    const screen = alignedCrop(720, 480, parsed)!, thumb = alignedCrop(160, 120, parsed)!;
    const sizes = GR3X_BASE_SIZES.map(([w, h]) => alignedCrop(w, h, parsed)!);
    return { id, ratio, n, d, screen, thumb, sizes };
  });
}

export function installGr3xDevelopAndPlayback(p: Gr3xProgram) {
  const CUSTOM = customsOf(p.menu), max = gr3xMaxId(p.menu);
  const replay: number[][] = [];
  for (const r of CUSTOM) {
    for (const size of r.sizes) replay.push([size.width, size.height,
      r.screen.left, r.screen.top, r.screen.width, r.screen.height,
      r.thumb.left, r.thumb.top, r.thumb.width, r.thumb.height]);
  }
  const replayTable = p.append(wordsToBytes(replay.flat()));
  const replayEntries: number[] = [];
  for (const [entry, offset] of [[0x534d5e14, 8], [0x534d5fe4, 24]]) {
    const body = p.code(`
      push {r0-r3,r4-r6,lr}; ldr r4,[r2]; ldr r5,[r2,#4]
      ${addr('r3', replayTable)} mov r6,#${replay.length}
      loop: ldr r1,[r3]; ldr r2,[r3,#4]; cmp r4,r1; cmpeq r5,r2; beq found
      add r3,r3,#40; subs r6,r6,#1; bne loop
      pop {r0-r3,r4-r6,lr}; mov ip,sp; b #${entry + 4}
      found:
      ldr r1,[r3,#${offset}]; str r1,[r0]
      ldr r1,[r3,#${offset + 4}]; str r1,[r0,#4]
      ldr r1,[r3,#${offset + 8}]; str r1,[r0,#8]
      ldr r1,[r3,#${offset + 12}]; str r1,[r0,#12]
      pop {r0-r3,r4-r6,pc}
    `);
    p.patch(entry, 0xe1a0c00d, branchWord(entry, body), 'playback: exact-size screen/thumbnail crop rectangle');
    replayEntries.push(body);
  }
  for (const [entry, kind] of [[0x536a2f50, 'screen'], [0x536a3008, 'thumb']] as const) {
    const body = p.code(CUSTOM.map(r => `cmp r1,#${r.id};beq ratio${r.id};`).join('') +
      `mov ip,sp;b #${entry + 4};` + CUSTOM.map(r => {
        const v = r[kind];
        return `ratio${r.id}:movw r0,#${v.left};movw r1,#${v.top};strh r0,[r2];strh r1,[r3];bx lr;`;
      }).join(''));
    p.patch(entry, 0xe1a0c00d, branchWord(entry, body), 'photo: screen/thumbnail origin for the custom crop');
  }
  const allocation = p.code(`
    push {r4,lr}; sub sp,sp,#8
    ldr r2,[r0]; ldr r3,[r0,#4]; add r3,r3,#7; bic r3,r3,#7
    str r2,[sp]; str r3,[sp,#4]; mov r0,sp; bl #0x534a2c14
    add sp,sp,#8; pop {r4,pc}
  `);
  p.patch(0x534aaadc, branchWord(0x534aaadc, 0x534a2c14, 14, true),
    branchWord(0x534aaadc, allocation, 14, true), 'playback: allocate complete JPEG MCU rows');

  const coefficients = new Uint8Array(4 * CUSTOM.length);
  const view = new DataView(coefficients.buffer);
  CUSTOM.forEach((r, i) => view.setFloat32(i * 4, Math.hypot(r.screen.width, r.screen.height) / Math.hypot(720, 480), true));
  const coeffTable = p.append(coefficients);
  const coefficient = p.code(`
    cmp r0,#4; blo native; cmp r0,#${max}; bhi native
    push {r0,ip}; sub r0,r0,#4; ${addr('ip', coeffTable)} add ip,ip,r0,lsl #2
    vldr s15,[ip]; pop {r0,ip}; cmp r7,#0; bne #0x535030e0; b #0x535030d4
    native: cmp r0,#1; b #0x5350311c
  `);
  p.patch(0x53503118, 0xe3500001, branchWord(0x53503118, coefficient), 'ImageDevelop: custom crop lens-correction diagonal');

  // Returns the custom size in r0/r1. Known outputs are idempotent, including
  // low-resolution rounded apertures. Other sizes fit the requested fraction.
  const cropSize = p.code(`
    push {r4-r8,lr}; mov r4,r0; mov r5,r1
    ${CUSTOM.map(r => `cmp r2,#${r.id};beq ratio${r.id};`).join('')}
    b done
    ${CUSTOM.map(r => {
      const exact: [number, number, Rect][] = [[720, 480, r.screen], [160, 120, r.thumb],
        ...GR3X_BASE_SIZES.map(([w, h], i): [number, number, Rect] => [w, h, r.sizes[i]])];
      return `ratio${r.id}:` + exact.map(([w, h, v]) =>
        `movw r6,#${w};cmp r4,r6;movw r6,#${h};cmpeq r5,r6;movweq r0,#${v.width};movweq r1,#${v.height};beq done;` +
        `movw r6,#${v.width};cmp r4,r6;movw r6,#${v.height};cmpeq r5,r6;beq unchanged;`).join('') +
        `${gr3xImm('r6', r.n)};${gr3xImm('r7', r.d)};b fit;`;
    }).join('')}
    unchanged: mov r0,r4;mov r1,r5;b done
    fit: mul r0,r4,r7;mul r1,r5,r6;subs r2,r0,r1;rsbmi r2,r2,#0
    cmp r6,r7;movhs r8,r6;movlo r8,r7;cmp r2,r8,lsl #1;bls unchanged
    cmp r0,r1;blo height
    mul r0,r5,r6;add r0,r0,r7,lsl #1;mov r1,r7,lsl #2;bl #0x5313d850
    mov r0,r0,lsl #2;mov r1,r5;b done
    height: mul r0,r4,r7;add r0,r0,r6,lsl #1;mov r1,r6,lsl #2;bl #0x5313d850
    mov r1,r0,lsl #2;mov r0,r4
    done: pop {r4-r8,pc}
  `);
  // IIIx differs substantially from IV here: r1 is the identity, lr is the
  // descriptor and the source dimensions are halfwords at +0x78/+0x7a.
  const develop = p.code(`
    cmp r1,#4;blo native;cmp r1,#${max};bhi native
    push {r4-r10,lr};ldrh r4,[lr,#0x78];ldrh r5,[lr,#0x7a]
    mov r2,r1;mov r0,r4;mov r1,r5;bl #${cropSize}
    mov r3,r0;mov r0,r1;sub r1,r4,r3;sub r2,r5,r0
    mov r1,r1,lsr #1;mov r2,r2,lsr #1;mov ip,r4;str r5,[sp,#24]
    pop {r4-r10,lr};b #0x535038f4
    native:cmp r1,#2;b #0x535037c8
  `);
  p.patch(0x535037c4, 0xe3510002, branchWord(0x535037c4, develop), 'ImageDevelop: custom final descriptor crop');
  return { replayScreen: replayEntries[0], replayThumbnail: replayEntries[1], replayTable,
    replayRows: replay.length, allocation, coefficient, cropSize, develop };
}

export function installGr3xAutofocus(p: Gr3xProgram) {
  const CUSTOM = customsOf(p.menu);
  const entries: number[] = [];
  for (const [site, kind] of [[0x532afc0c, 'rectangle'], [0x532afe44, 'size'], [0x532afe74, 'small']] as const) {
    let source = CUSTOM.map(r => `cmp r0,#${r.id};beq ratio${r.id};`).join('') + `cmp r0,#0;b #${site + 4};`;
    for (const r of CUSTOM) {
      const s = r.screen;
      const left = Math.max(80, s.left), top = Math.max(60, s.top);
      const right = Math.min(640, s.left + s.width), bottom = Math.min(420, s.top + s.height);
      source += `ratio${r.id}:`;
      if (kind === 'rectangle') source += `movw r0,#${bottom};movw r1,#${left};movw r2,#${top};movw r3,#${right};b #0x532afbf0;`;
      else {
        const w = kind === 'size' ? right - left : Math.floor((right - left) * 3 / 5);
        const h = kind === 'size' ? bottom - top : Math.floor((bottom - top) * 3 / 5);
        source += `movw r1,#${w};movw r2,#${h};mov r0,r5;bl #0x536b5d20;b #0x532afdd8;`;
      }
    }
    const body = p.code(source);
    p.patch(site, 0xe3500000, branchWord(site, body), 'AF: constrain native focus rectangles to the selected crop');
    entries.push(body);
  }
  return { afRectangle: entries[0], afSize: entries[1], afSmall: entries[2] };
}
