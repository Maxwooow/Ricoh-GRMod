// SPDX-License-Identifier: GPL-2.0-only
/** GR IIIx 1.71 / GR III 2.21. This directory holds only what is this release's own: this target, the address
 * table (made by tools/port/addresses.py from the address maps) and the compiled native modules. Every other
 * module is fw/gr3x's, loaded with this target. See release.ts. */
import { releaseTarget } from '../release';
import { ADDRESSES } from './addresses';

export const { release, adr, adrHex, adrHEX, adrText, byRelease } = releaseTarget('1.71', ['1.60', '1.70', '1.71'], ADDRESSES);
