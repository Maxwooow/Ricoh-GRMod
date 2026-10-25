// SPDX-License-Identifier: GPL-2.0-only
// Adapted from the reference's crop_raw.py / crop_image_map.c.
import { branchWord, movWord, wordsToBytes } from '../aspect/arm';
import { FirmwareError } from '../types';
import { GR3X_MAP_NATIVE } from './map-native';
import type { Gr3xProgram } from './image-pipeline';
import { GR3X_MAX_CUSTOM_RATIOS, gr3xCustoms, gr3xMaxId } from './geometry';
import { alignedCrop, parseRatio } from '../aspect/geometry';

const addr = (reg: string, value: number) => `movw ${reg},#${value & 65535};movt ${reg},#${value >>> 16};`;
const VIEW_BYTES = 304 + 12 * 36;

export function installGr3xMetering(p: Gr3xProgram) {
  const max = gr3xMaxId(p.menu);
  const rows = gr3xCustoms(p.menu).flatMap(({ id, ratio }) => {
    const screen = alignedCrop(720, 480, parseRatio(ratio))!;
    return [id, screen.width, 720, screen.height, 480];
  });
  // map.c declares seven rows and seven views. Unused rows are never selected (identities above
  // the last added ratio stay native); they hold the full 3:2 view.
  for (let id = max + 1; id < 4 + GR3X_MAX_CUSTOM_RATIOS; id++) rows.push(id, 720, 720, 480, 480);
  const table = p.append(wordsToBytes(rows));
  const origin = p.next();
  const module = GR3X_MAP_NATIVE;
  const body = Uint8Array.from(module.code.match(/../g)!, s => parseInt(s, 16));
  const dv = new DataView(body.buffer);
  for (const [offset, kind, symbol, addend] of module.relocs) {
    if (symbol !== 'ratios' || addend !== 0 || (kind !== 43 && kind !== 44)) {
      throw new FirmwareError('internal', 'Unexpected IIIx native-module relocation');
    }
    const old = dv.getUint32(offset, true), register = (old >>> 12) & 15;
    if (old !== movWord(register, 0, kind === 44)) throw new FirmwareError('internal', 'IIIx module MOV relocation changed');
    dv.setUint32(offset, movWord(register, kind === 43 ? table & 65535 : table >>> 16, kind === 44), true);
  }
  if (p.append(body) !== origin) throw new FirmwareError('internal', 'IIIx map module moved');
  const makeView = origin + module.exports.crop_make_view;
  const cloneTail = origin + module.exports.crop_clone_tail;
  const allocation = p.code(`
    ldr r0,[fp,#-0x30];sub r0,r4,r0;cmp r0,#4
    mov r0,#34;movweq r0,#${36 + 7 * VIEW_BYTES};b #0x5365da04
  `);
  p.patch(0x5365da00, 0xe3a00022, branchWord(0x5365da00, allocation), 'metering: extend only primary record zero allocation');
  const identity = p.code(`
    uxtb r0,r0;cmp r0,#4;blo native;cmp r0,#${max};bxls lr
    native:b #0x536a3204
  `);
  p.patch(0x536a3200, 0xe6ef0070, branchWord(0x536a3200, identity), 'metering: preserve known custom aspect until selecting its map view');
  interface Options { normalize?: number; index?: number; post?: string; parameter?: boolean }
  const wrapper = (site: number, expected: number, map: string, id: string, dest: number, o: Options = {}) => {
    let source = `push {r0-r12,lr};mrs ip,apsr;sub sp,sp,#16;str ip,[sp];${map}str r0,[sp,#4];${id}str r1,[sp,#8];bl #${makeView};ldr ip,[sp,#4];cmp r0,ip;str r0,[sp,#${16 + dest * 4}];`;
    if (o.normalize !== undefined) source += `movne ip,#0;strne ip,[sp,#${16 + o.normalize * 4}];`;
    if (o.index !== undefined) source += `ldrne ip,[sp,#8];ldrne r0,[sp,#${16 + o.index * 4}];subne r0,r0,ip;subne r0,r0,ip,lsl #1;strne r0,[sp,#${16 + o.index * 4}];`;
    if (o.parameter) source += 'movne ip,#0;strne ip,[fp,#-0x34];ldrne r2,[sp,#28];strne ip,[r2,#0x2c];';
    source += `ldr ip,[sp];msr apsr_nzcvq,ip;add sp,sp,#16;pop {r0-r12,lr};${o.post ?? ''}b #${site + 4};`;
    const at = p.code(source);
    p.patch(site, expected, branchWord(site, at), 'metering: select cropped IIIx AE/AWB records without indexing outside native arrays');
  };
  wrapper(0x535001b0, 0xe593cba8, 'ldr r0,[r3,#0xba8];', 'mov r1,r4;', 12, { normalize: 4 });
  wrapper(0x535002e4, 0xe5941ba8, 'ldr r0,[r4,#0xba8];', 'mov r1,r8;', 1, { normalize: 8 });
  wrapper(0x53501b90, 0xe5943ba8, 'ldr r0,[r4,#0xba8];', 'mov r1,r8;', 3, { normalize: 8 });
  wrapper(0x535071dc, 0xe5931a10, 'ldr r0,[r3,#0xa10];', 'ldr r1,[r5,#0x34];ldrb r1,[r1,#0x7b6];', 1, { index: 4 });
  wrapper(0x5350a24c, 0xe59a4a10, 'ldr r0,[sl,#0xa10];', 'ldr r1,[fp,#-0x34];', 4, { parameter: true });
  wrapper(0x5350a454, 0xe5983a10, 'ldr r0,[r8,#0xa10];', 'mov r1,r7;', 3, { normalize: 7 });
  wrapper(0x5350ca4c, 0xe0866100, 'mov r0,r6;', 'ldr r1,[r5,#0x34];ldrb r1,[r1,#0x7b6];', 6, { index: 0, post: 'add r6,r6,r0,lsl #2;' });
  wrapper(0x5350cb88, 0xe0855100, 'mov r0,r5;', 'ldr r1,[r4,#0x34];ldrb r1,[r1,#0x7b6];', 5, { index: 0, post: 'add r5,r5,r0,lsl #2;' });
  wrapper(0x53525798, 0xe0872102, 'mov r0,r7;', 'mov r1,r8;', 7, { index: 2, post: 'add r2,r7,r2,lsl #2;' });
  const originalClone = p.code('mov ip,sp;b #0x5365e2e0;');
  const clone = p.code(`push {r0-r3,ip,lr};bl #${originalClone};pop {r0-r3,ip,lr};push {r0-r3,ip,lr};bl #${cloneTail};pop {r0-r3,ip,lr};bx lr;`);
  p.patch(0x5365e2dc, 0xe1a0c00d, branchWord(0x5365e2dc, clone), 'metering: rebind cloned custom views to the destination map');
  return { mapView: makeView, mapCloneTail: cloneTail, mapAllocation: allocation, mapIdentity: identity, mapTable: table };
}
