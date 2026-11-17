// SPDX-License-Identifier: GPL-2.0-only
/** The GR III / IIIx program in fw/gr3x is written for GR IIIx 1.60 / GR III 2.10 (its addresses are theirs)
 * and also builds 1.70 / 2.20 and 1.71 / 2.21, whose directories fw/gr3x170 and fw/gr3x171 have targets of
 * their own. A release is named by its GR IIIx number. Here, for 1.60 / 2.10, addresses are used as they
 * are written. See release.ts. */
import { releaseTarget } from '../release';

export const { release, adr, adrHex, adrHEX, adrText, byRelease } = releaseTarget('1.60', ['1.60', '1.70', '1.71'], null);
