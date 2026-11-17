// SPDX-License-Identifier: GPL-2.0-only
/** The GR IV program in fw/ (profile, patch, names, ... and aspect/) is written for firmware 1.11 and builds
 * only that release: addresses are used as they are written. See release.ts. */
import { releaseTarget } from './release';

export const { release, adr, adrHex, adrHEX, adrText, byRelease } = releaseTarget('1.11', ['1.11'], null);
