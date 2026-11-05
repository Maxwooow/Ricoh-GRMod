// SPDX-License-Identifier: GPL-2.0-only
/**
 * What the engine (../../app/engine.ts) uses of one GR III / IIIx program: this directory is GR IIIx
 * 1.60 / GR III 2.10; its generated port ../gr3x170 (tools/port/generate.py) has the same file for
 * GR IIIx 1.70 / GR III 2.20. The engine keeps the program of the file it opened and calls only
 * through it, so an address of one program is never used with the other's file.
 */
export { GR3X_170 as GR3_LAYOUT, GR3_PROFILES, gr3ProfileOf, openGr3xOfficial } from './profile';
export { buildGr3xTestFirmware } from './research-package';
export { readGr3xFactoryEntry } from './factory';
export { GR3X_CLARITY_OFFSET } from './clarity';
export { gr3xAllowedChars, gr3xLookResources } from './look-resources';
export { GR3X_MAX_PICTURES, gr3xPicturePath } from './shutdown';
export { readGr3xBuildRecipe } from './ratio-recipe';
export { readGr3xLookRecipe } from './look-recipe';
export { GR3X_FACTORY_PICTURES } from './endscreen';
