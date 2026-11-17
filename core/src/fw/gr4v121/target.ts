// SPDX-License-Identifier: GPL-2.0-only
/** GR IV 1.21 (also GR IV Monochrome 1.11, the same file). This directory holds only what is 1.21's own: this
 * target, the address table (made by tools/port/addresses.py from the address map) and the compiled native
 * modules in aspect/. Every other module is fw/gr4v120's, loaded with this target. See release.ts. */
import { releaseTarget } from '../release';
import { ADDRESSES } from './addresses';

export const { release, adr, adrHex, adrHEX, adrText, byRelease } = releaseTarget('1.21', ['1.20', '1.21'], ADDRESSES);
