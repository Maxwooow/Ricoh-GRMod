// SPDX-License-Identifier: GPL-2.0-only
// IIIx mappings were traced from its UserData getter and native preview callers.
import { branchWord, wordsToBytes } from '../aspect/arm';
import { alignedCrop, parseRatio } from '../aspect/geometry';
import { gr3xCustoms, gr3xMaxId, gr3xWide } from './geometry';
import type { Gr3xProgram } from './image-pipeline';

const addr = (r: string, v: number) => `movw ${r},#${v & 65535};movt ${r},#${v >>> 16};`;

export function installGr3xLiveView(p: Gr3xProgram) {
  const max = gr3xMaxId(p.menu);
  const rows = gr3xCustoms(p.menu).map(({ id, ratio }) => {
    const r = alignedCrop(720, 480, parseRatio(ratio))!;
    return { id, at: p.append(wordsToBytes([r.width, 720, r.height, 480])) };
  });
  // Hardware-wide family (wider than 3:2): one range test when the identities are consecutive.
  const wide = gr3xCustoms(p.menu).filter(gr3xWide).map(r => r.id);
  const wideTest = !wide.length ? 'b narrow;'
    : wide.every((id, i) => id === wide[0] + i)
    ? `cmp r8,#${wide[0]};blo narrow;cmp r8,#${wide[wide.length - 1]};bls #0x534506b8;`
    : wide.map(id => `cmp r8,#${id};beq #0x534506b8;`).join('');
  const get = p.code(rows.map(r => `cmp r0,#${r.id};${addr('ip', r.at)}moveq r0,ip;bxeq lr;`).join('') + 'mov r0,#0;bx lr;');
  const scale = p.code('mov ip,r1;mov r3,#0;umull r0,r1,r0,ip;b #0x5313db54;');
  const hook = (site: number, expected: number, source: string) => {
    const at = p.code(source);
    p.patch(site, expected, branchWord(site, at), 'IIIx live view: preserve and apply custom crop identity');
    return at;
  };
  // SetupFaceDetectionConfig (0x53450368) previously took its
  // unknown-aspect assertion for every custom ID. That route leaves +0x42f6
  // unchanged, so the hardware mode depends on the previous capture descriptor.
  // This is an AE/AF face-detection descriptor, not the display DMA buffer.
  // Retain the T2 behavior here. The IIIx hardware-wide family sets mode 2;
  // the native square family uses
  // explicit dimensions when enabled (mode 3), otherwise mode 0. Keep the custom
  // identity in r8; only select a supported hardware descriptor branch.
  const resumeMode = hook(0x53450668, 0xe3580003,
    `cmp r8,#4;blo native;cmp r8,#${max};bhi native;${wideTest}narrow:b #0x53450790;native:cmp r8,#3;b #0x5345066c;`);
  // Public 0/1/2/3 maps to hardware 0/2/1/3. Additional IDs keep their identity.
  hook(0x53669444, 0xe2400001,
    `cmp r0,#4;blo old;cmp r0,#${max};movls r4,r0;bls #0x53669460;old:sub r0,r0,#1;b #0x53669448;`);
  // The secondary preview controller has an inlined copy of the same converter.
  hook(0x534371c8, 0xe2400001,
    `cmp r0,#4;blo old;cmp r0,#${max};bhi old;mov r5,r0;ldr r0,[r6,#8];mov r1,#0;b #0x534371ec;old:sub r0,r0,#1;b #0x534371cc;`);
  hook(0x53437210, 0xe2451003,
    `cmp r5,#4;blo old;cmp r5,#${max};movls r1,#1;bls #0x5343721c;old:sub r1,r5,#3;b #0x53437214;`);
  // Every main-controller path must choose its computed aperture, including no zoom.
  for (const [site, join] of [[0x53445074,0x53445080],[0x534461b8,0x53445e50],
    [0x53446f84,0x53446de8],[0x534475a8,0x534475bc],[0x53447efc,0x53447f08]]) {
    hook(site, 0xe3510003,
      `cmp r1,#4;blo old;cmp r1,#${max};bhi old;orr r1,r3,#1;b #${join};old:cmp r1,#3;b #${site + 4};`);
  }
  const dimensionEntries: number[] = [];
  for (const [entry, word, displaced, axis, comparison] of [
    [0x53668774,0xe5d0c005,'ldrb ip,[r0,#5]',0,3],
    [0x53668be4,0xe5d00005,'ldrb r0,[r0,#5]',8,1],
  ] as const) {
    const original = p.code(`${displaced};b #${entry + 4};`);
    const call = `mov r0,r4;mov r1,r5;mov r2,r6;mov r3,r7;bl #${original};`;
    let out = `push {r4-r10,lr};mov r4,r0;mov r5,r1;mov r6,r2;mov r7,r3;ldr r0,[sp,#36];bl #${get};cmp r0,#0;beq old;mov r8,r0;sub sp,sp,#16;ldr r0,[sp,#48];str r0,[sp];mov r0,#0;str r0,[sp,#4];`;
    out += call + `mov r9,r0;mov r0,#${comparison};str r0,[sp,#4];` + call + 'cmp r0,r9;beq base;';
    if (axis === 0) {
      // IIIx SetupDevelopmentDestinationCh0 subtracts this aperture width from
      // the native 3:2 width (recipe +0x558) before storing a uint16 source X.
      // Borrowing the native 16:9 width, as the IV port does, makes that X wrap:
      // e.g. (1080 - 1280) / 2 -> 65436. Keep the 3:2 width for vertical crops;
      // only the height changes. The independent full-recipe probe covers the
      // actual consumer at 0x53457e00 and reproduces the T2 out-of-bounds X.
      out += 'ldr r1,[r8];ldr r2,[r8,#4];cmp r1,r2;bhs base;';
    } else out += 'ldr r1,[r8,#8];ldr r2,[r8,#12];';
    // A vertically cropped YUV420 aperture must leave an even centre offset.
    // The native photo mode with a 448-row canvas otherwise yields 378/246/238
    // rows and origins 35/101/105. Ch0 passes those odd offsets into both image
    // addresses, and the software resizer uses the same odd destination Y.
    // Keep complete four-row groups, including native mode overrides. This
    // only changes custom vertical crops; native IDs and horizontal crops keep
    // their existing results. It does not change JPEG or DNG geometry.
    const alignHeight = axis === 8
      ? 'ldr r1,[r8,#8];ldr r2,[r8,#12];cmp r1,r2;biclo r0,r0,#3;'
      : '';
    out += `scale:mov r0,r9;bl #${scale};add r0,r0,#1;bic r0,r0,#1;b done;base:mov r0,r9;done:${alignHeight}add sp,sp,#16;pop {r4-r10,pc};old:mov r0,r4;mov r1,r5;mov r2,r6;mov r3,r7;pop {r4-r10,lr};b #${original};`;
    dimensionEntries.push(hook(entry, word, out));
  }
  // IIIx's vertical helper uses hardware-wide 1, unlike the IV's extra wide mode 5.
  hook(0x536699c4, 0xe3570001,
    `push {r0-r3,ip,lr};mov r0,r7;bl #${get};cmp r0,#0;beq old;ldr r1,[r0,#8];ldr r2,[r0,#12];cmp r1,r2;pop {r0-r3,ip,lr};mov r7,r8;orrlo r7,r8,#1;b #0x536699d0;old:pop {r0-r3,ip,lr};cmp r7,#1;b #0x536699c8;`);
  // Match the physical-height alignment in both resize ROI paths. Aligning
  // only the destination would leave the YUV420 source on an odd row.
  const crop = `bl #${get};cmp r0,#0;beq old;mov r8,r0;mov r0,r6;ldr r1,[r8];ldr r2,[r8,#4];bl #${scale};add r0,r0,#1;bic r6,r0,#1;mov r0,r5;ldr r1,[r8,#8];ldr r2,[r8,#12];bl #${scale};add r0,r0,#1;bic r5,r0,#1;ldr r1,[r8,#8];ldr r2,[r8,#12];cmp r1,r2;biclo r5,r5,#3;`;
  hook(0x53459458, 0xe3520c01,
    `push {r0-r4,r7-r12,lr};mov r0,sl;${crop}old:pop {r0-r4,r7-r12,lr};cmp r2,#0x100;b #0x5345945c;`);
  hook(0x53459bd4, 0x950b5064,
    `push {r0-r4,r7-r12,lr};mov r0,sl;mrs r10,apsr;${crop}old:msr apsr_nzcvq,r10;pop {r0-r4,r7-r12,lr};strls r5,[fp,#-0x64];b #0x53459bd8;`);
  // ROI has been cropped once above; converter calls operate on its physical canvas.
  for (const [site, target, r] of [[0x5345942c,0x53669790,'r3'],[0x53459444,0x53669978,'r3'],
    [0x534594ac,0x53669490,'r2'],[0x534594d4,0x536695f8,'r2'],
    [0x53459c00,0x53669490,'r2'],[0x53459c24,0x536695f8,'r2']] as const) {
    hook(site, branchWord(site, target, 14, true),
      `push {r0-r3,ip,lr};mov r0,${r};bl #${get};cmp r0,#0;pop {r0-r3,ip,lr};movne ${r},#0;${addr('lr',site + 4)}b #${target};`);
  }
  // Archived source rectangle uses native magnification lookup and its initialized Q16 plane.
  const metadata = hook(0x535ee890,0xe1a0c00d,`
    push {r4-r10,lr};mov r4,r0;ldr r5,[r0,#8];ldrb r0,[r5,#0x7b6]
    bl #${get};cmp r0,#0;beq native;mov r8,r0
    add ip,r5,#0x7b0;vldr s0,[ip,#8];bl #0x535f4808;cmp r0,#0;beq done
    ldr r6,[r0];ldr r7,[r0,#4];ldr r9,[r0,#8];ldr r10,[r0,#12]
    mov r0,r6;ldr r1,[r8];ldr r2,[r8,#4];bl #${scale}
    sub r6,r6,r0;add r9,r9,r6,lsr #1;str r0,[r5,#0x6a0];str r9,[r5,#0x6a8]
    mov r0,r7;ldr r1,[r8,#8];ldr r2,[r8,#12];bl #${scale}
    sub r7,r7,r0;add r10,r10,r7,lsr #1;str r0,[r5,#0x6a4];str r10,[r5,#0x6ac]
    done:pop {r4-r10,pc}
    native:mov r0,r4;pop {r4-r10,lr};mov ip,sp;b #0x535ee894
  `);
  return { liveResumeMode: resumeMode, liveLookup: get, liveScale: scale, liveWidth: dimensionEntries[0], liveHeight: dimensionEntries[1], metadataRectangle:metadata };
}
