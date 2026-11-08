// SPDX-License-Identifier: GPL-2.0-only
/** PR #21: add a boundary-continuous correction to Standard's sector matrices. */
export function composeAdditive(standard: readonly (readonly number[])[], correction: readonly (readonly number[])[]): number[][] {
  return standard.map((m, g) => m.map((v, k) => v + correction[g][k] - (k % 4 === 0 ? 1 : 0)));
}
