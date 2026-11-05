// SPDX-License-Identifier: GPL-2.0-only
import { branchWord } from '../aspect/arm';
import type { Gr3xProgram } from './image-pipeline';
import { gr3xMaxId } from './geometry';

export function installGr3xShading(p: Gr3xProgram) {
  // XoyShadingCoordinator has its own amount/profile tables and magnification.
  // Reuse its native 3:2 correction for added crops. Custom profiles have not
  // been optically calibrated; do not invent constants or modify the setting.
  // Both the indexed and default-amount branches contain an enum assertion.
  const max = gr3xMaxId(p.menu);
  const entries = [0x536efc2c, 0x536efcb8].map(site => {
    const body = p.code(`
      cmp r0,#4; blo native; cmp r0,#${max}; movls r0,#0
      native: cmp r0,#0; b #${site + 4}
    `);
    p.patch(site, 0xe3500000, branchWord(site, body),
      'Xoy shading: use the native 3:2 correction profile for added crops');
    return body;
  });
  return { shadingDefault: entries[0], shadingIndexed: entries[1] };
}
