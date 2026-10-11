// SPDX-License-Identifier: GPL-2.0-only
import { branchWord, wordsToBytes } from '../aspect/arm';
import type { Gr3xProgram } from './image-pipeline';

/** Only the DNG descriptor writer gets a full-sensor window. The shared JPEG
 * dimension routine, captured aspect identity and embedded preview stay cropped.
 * Camera samples confirm 6112x4064 Bayer storage; its normal photo area is
 * 6000x4000 at (68,40), including when digital crop is selected. */
export function installGr3xFullFrameRaw(p: Gr3xProgram) {
  const one = p.append(wordsToBytes([0x3f800000]));
  const entry = p.code(`push {ip,lr};mov r2,#0;movw ip,#${one & 65535};movt ip,#${one >>> 16};vldr s0,[ip];bl #0x536610e0;pop {ip,pc};`);
  const site = 0x5351089c;
  p.patch(site, branchWord(site, 0x536610e0, 14, true), branchWord(site, entry, 14, true),
    'DNG DefaultCrop: full 6000x4000 at 1x; JPEG and preview retain selected aspect');
  return { rawFullFrame: entry };
}
