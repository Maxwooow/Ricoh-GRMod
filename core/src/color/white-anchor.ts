// SPDX-License-Identifier: GPL-2.0-only
/** PR #22: retain the LUT's white while fitting RGB curves and hue sectors. */
export const FIT_WHITE_COPIES = 200;
export const HUE_WHITE_WEIGHT = 1500;
export function withWhiteSamples(base: Float64Array): Float64Array {
  const out = new Float64Array(base.length + 3 * FIT_WHITE_COPIES);
  out.set(base); out.fill(1, base.length); return out;
}
