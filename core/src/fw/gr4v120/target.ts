// SPDX-License-Identifier: GPL-2.0-only
/** The GR IV program in fw/gr4v120 is written for firmware 1.20 (its addresses are 1.20's) and also builds
 * 1.21, whose directory fw/gr4v121 has a target of its own. Here, for 1.20, addresses are used as they are
 * written. See release.ts. */
import { releaseTarget } from '../release';

export const { release, adr, adrHex, adrHEX, adrText, byRelease } = releaseTarget('1.20', ['1.20', '1.21'], null);
