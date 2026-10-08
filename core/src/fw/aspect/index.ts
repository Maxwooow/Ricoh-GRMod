// SPDX-License-Identifier: GPL-2.0-only
/** Added aspect ratios for firmware 1.11. See `build.ts` for what is installed and where it comes from. */
export { Frac } from './fraction';
export { PLANE_H, PLANE_W, SCREEN_H, SCREEN_W, alignedCrop, fullSize, gr4Sizes, parseRatio, planRatio, playbackRectangles, ratioText, sourceRectangles } from './geometry';
export type { PhotoSize, RatioGeometry, RatioProblem, Rect, ReplayRect } from './geometry';
export { RATIO_ICON_BYTES, RATIO_ICON_H, RATIO_ICON_W, drawRatioIcon, ratioLabel } from './icon';
export {
  APPEND_LIMIT, BASE, BUILD_REVISION, COUNT_SITES, FIRST_CUSTOM_ID, ICON_CATALOG, MAX_CUSTOM_RATIOS, MAX_NAME_LENGTH, OFFICIAL_ICONBIN_LENGTH, OFFICIAL_RTOS_LENGTH, ORDER_SITES,
  TEXT_CATALOG, installRatios, planRatios, textId, validateRatioName,
} from './build';
export type { AspectResult, BuildRevision, PatchedWord, RatioEntry, RatioSpec } from './build';
