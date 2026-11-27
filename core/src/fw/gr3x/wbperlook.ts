// SPDX-License-Identifier: GPL-2.0-only
/**
 * White balance per look on GR III / IIIx (round 10, with films): each look remembers the still white
 * balance it was last used with and gets it back when it is chosen again. The code is films.c built
 * with -DWB_PER_LOOK (films-wb-native.ts, written by tools/gr3x/gen_films.py --wb); its hooks are in
 * films-r10.ts. The white balance fields, their setters and the photo-set setter are GR III 2.10 /
 * GR IIIx 1.60 addresses, not mapped for 1.70 / 1.71 (2.20 / 2.21): offered on 1.60 only.
 */
import { release } from './target';

export function gr3xWbPerLookOffered(): boolean {
  return release === '1.60';
}
