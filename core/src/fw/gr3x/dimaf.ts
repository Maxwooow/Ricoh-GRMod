// SPDX-License-Identifier: GPL-2.0-only
/**
 * Dim-light AF (GR IIIx 1.60 / 1.70 / 1.71, GR III 2.10 / 2.20 / 2.21): the contrast AF's peak detector and its frame rate set as tested on
 * the camera ("X875+FALLS2+OPT+NO29" in the study behind it, github.com/nils-fl/RicohGR,
 * docs/af-debug-log.html "Parameter search with Optuna" and "The setting flashed into the firmware").
 *
 * Nineteen words in place, nothing appended, no hook. Every word lies in the contrast-AF units CafProcess,
 * CafDetection and CafWobbling (compiled back to back, 0x533f3d18 .. 0x53417990) or in data only they read;
 * every caller of the patched function 0x5340c590 (5) and of 0x533f4a70 (3) is AF code. That code runs only
 * while the camera focuses in a shooting mode, so the update mode (MENU at power-on) never runs it.
 *
 *   X875     0x5340c5f0..0x5340c614  10 instructions of 0x5340c590, the detector's margin scale: x^0.875
 *                                    (x / x^0.125: three vsqrt and a vdiv) in place of the stock step, the same
 *                                    bright-light branch (bhi 0x5340c618) and the 0.25 floor. Scale 6 -> 4.8,
 *                                    13 -> 9.4, 27 -> 17.9, 59 -> 35.
 *   OPT kb   0x53c16bb0..0x53c16bc4  the six per-mode margin bases that 0x5340c590 reads (569.22, 569.22, 574.5,
 *                                    597.85, 563.3, 563.3), x 0.32.
 *   OPT rise 0x53c16d14              mode 0's absolute floor of the detector threshold (read only by 0x5340c3c4):
 *                                    0.02 -> 0.014.
 *   FALLS2   0x53c16cc0              the rising run that arms the detector's return value (read only at
 *                                    0x5340dcc0): 3 -> 2 samples.
 *   NO29     0x533f4b10              the drive-level choice 0x533f4a70: its level-3 store movhi r3,#3 -> #2, so
 *                                    light that gives 29 fps gives 49 fps; brighter light (levels 0..2) unchanged.
 *
 * On the camera (GR IIIx 1.60, centre AF area, tripod, Wi-Fi bench patching the RAM, shuffled arms):
 *   a scene where stock focuses at 29 fps, 72 presses, all locked: stock 622 ms median, this setting 486 ms
 *   (permutation test p = 0.001), final positions as stock's;
 *   dim, AF-C held, first run: stock 29 fps 12 / 12 locked 1769 ms, this setting 49 fps 15 / 16 locked 1026 ms;
 *   bright (stock at 100 fps), all locked: stock 322..327 ms, this setting 315 ms (15 presses).
 * Flashed (the same nineteen words, built by the study's own tool) and used on the camera 2026-11-20..25.
 *
 * 1.70 and 1.71: the contrast-AF region (0x533f3d18 .. 0x53417990 in 1.60) is the same code in all three releases up to
 * relocation (only a block of linker veneers moved); the sites are found once each with the code around them, and the
 * data through the same movw / movt of the same code, every value equal (tools/port/gr3-p2-overrides.json,
 * gr3-p3-overrides.json). Two stock words differ there, both overwritten: the movw of the 0.25 floor's address (the
 * data moved) and the bl to sqrt (the library moved). The words written are the same in every release.
 *
 * GR III (2.10 / 2.20 / 2.21): its RTOS is GR IIIx's (1.60 / 1.70 / 1.71) but for 18 or 19 identity words (camera name,
 * version, build), none in the contrast-AF code or data, so the same nineteen words change the same code. The tuning was
 * found on the GR IIIx's 40 mm lens; on the GR III's 28 mm it has not been tried on a camera.
 */
import type { Gr3xProgram } from './image-pipeline';
import { adr, byRelease } from './target';

type Site = readonly [address: number, stock: number, patched: number, reason: string];

/** The two stock words that name a moved address (the 0.25 floor's movw, the bl to sqrt); both are overwritten. */
const FLOOR_MOVW = byRelease({ '1.60': 0xe3063bd4, '1.70': 0xe3063514, '1.71': 0xe30e3a2c });
const SQRT_BL = byRelease({ '1.60': 0xebf51d64, '1.70': 0xebf51d58, '1.71': 0xebf516e4 });

const X875 = 'dim-light AF: margin scale x^0.875 (X875)';
const KB = 'dim-light AF: margin base x 0.32';

/** The nineteen words: address (this release's), stock word, word written, why. */
export const GR3X_DIM_LIGHT_AF_SITES: readonly Site[] = [
  [adr(0x5340c5f0), 0x8a000008, 0x8eb17ac0, X875],
  [adr(0x5340c5f4), FLOOR_MOVW, 0x8eb17ac7, X875],
  [adr(0x5340c5f8), 0xe34533c1, 0x8eb17ac7, X875],
  [adr(0x5340c5fc), 0xedd37a00, 0x8e800a07, X875],
  [adr(0x5340c600), 0xeeb40ae7, 0x8a000004, X875],
  [adr(0x5340c604), 0xeef1fa10, 0xeef57a00, X875],
  [adr(0x5340c608), 0x5ef07a40, 0xeeb40ae7, X875],
  [adr(0x5340c60c), 0xeeb70ae7, 0xeef1fa10, X875],
  [adr(0x5340c610), SQRT_BL, 0x4eb00a67, X875],
  [adr(0x5340c614), 0xeeb70bc0, 0xeeb10ac0, X875],
  [adr(0x53c16bb0), 0x440e4e14, 0x43362680, KB],
  [adr(0x53c16bb4), 0x440e4e14, 0x43362680, KB],
  [adr(0x53c16bb8), 0x440fa000, 0x4337d70a, KB],
  [adr(0x53c16bbc), 0x44157666, 0x433f4fdf, KB],
  [adr(0x53c16bc0), 0x440cd333, 0x43344189, KB],
  [adr(0x53c16bc4), 0x440cd333, 0x43344189, KB],
  [adr(0x53c16d14), 0x3ca3d70a, 0x3c656042, 'dim-light AF: mode-0 rise floor 0.02 -> 0.014'],
  [adr(0x53c16cc0), 0x00000003, 0x00000002, 'dim-light AF: rising run of 2 arms the detector (FALLS2)'],
  [adr(0x533f4b10), 0x83a03003, 0x83a03002, 'dim-light AF: 49 instead of 29 fps in dim light (NO29)'],
];

/** True for GR IIIx (1.60, 1.70, 1.71), where the words were tuned and tested, and GR III (2.10, 2.20, 2.21), whose AF
 * program is the same. */
export function gr3xDimLightAfOffered(profile: { readonly model: string }): boolean {
  return profile.model === 'GR3X_HDF' || profile.model === 'GR3_HDF';
}

/** The words of GR III / IIIx: the caller checks `gr3xDimLightAfOffered` (adj.ts). */
export function installGr3xDimLightAf(p: Pick<Gr3xProgram, 'patch'>): void {
  for (const [address, stock, patched, reason] of GR3X_DIM_LIGHT_AF_SITES) p.patch(address, stock, patched, reason);
}
