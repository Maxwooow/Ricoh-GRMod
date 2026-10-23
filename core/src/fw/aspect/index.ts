// SPDX-License-Identifier: GPL-2.0-only
/** Added aspect ratios for firmware 1.11. See `build.ts` for what is installed and where it comes from. */
export { Frac } from './fraction';
export { PLANE_H, PLANE_W, SCREEN_H, SCREEN_W, alignedCrop, fullSize, gr4Sizes, parseRatio, planRatio, playbackRectangles, ratioText, sourceRectangles } from './geometry';
export type { PhotoSize, RatioGeometry, RatioProblem, Rect, ReplayRect } from './geometry';
export { RATIO_ICON_BYTES, RATIO_ICON_H, RATIO_ICON_W, drawRatioIcon, ratioLabel } from './icon';
export {
  APPEND_LIMIT, BASE, BUILD_REVISION, COUNT_SITES, FIRST_CUSTOM_ID, ICON_CATALOG, MAX_CUSTOM_RATIOS, MAX_NAME_LENGTH, OFFICIAL_ICONBIN_LENGTH, OFFICIAL_RTOS_LENGTH, ORDER_SITES,
  TEXT_CATALOG, installExtensions, installRatios, planRatios, textId, validateRatioName,
} from './build';
export { ADJ_SOFT_FOCUS, SOFT_FOCUS_BYTE, SOFT_FOCUS_ICON_ID, SOFT_FOCUS_NAMES, SOFT_FOCUS_TEXT_ID, drawSoftFocusIcon, softFocusRows } from './softfocus';
export type { AspectResult, BuildRevision, ExtensionFeatures, PatchedWord, RatioEntry, RatioSpec, TestOptions } from './build';
export { DATESTAMP_BYTE, DATESTAMP_LONG, DATESTAMP_ON, JPEG_EXECUTE, datestampModule, installDateStamp } from './datestamp';
export { DATESTAMP_ICON_IDS, DATESTAMP_MENU_ID, DATESTAMP_STYLE_ID, DATESTAMP_SWITCH_ID, DATESTAMP_TEXT_IDS, drawStyleIcon, installDateStampMenu } from './datestamp-menu';
export { CINEMA_STYLES, EXTRA_FIRST_STYLE, EXTRA_ICON_BYTES, EXTRA_ICON_ID, EXTRA_NAME_MAX, EXTRA_TEXT_ID, MAX_EXTRA_SLOTS, extraIconId, extraTextId, installExtraSlots, installHalation, readExtraSlots, validateExtraSlotName } from './slots';
export type { ExtraSlotSpec } from './slots';
export { FACTORY_PICTURES, PREVIEW_HEIGHT, PREVIEW_WIDTH, SHUTDOWN_HEIGHT, SHUTDOWN_ICON_ID, SHUTDOWN_JPEG_BYTES, SHUTDOWN_MAX_PICTURES, SHUTDOWN_NAME_MAX, SHUTDOWN_FACTORY_TEXT, SHUTDOWN_MENU_ID, SHUTDOWN_PICTURE_ID, SHUTDOWN_PICTURE_NAMES, SHUTDOWN_PICTURE_TEXT, SHUTDOWN_RECORD, SHUTDOWN_TEXT_ID, SHUTDOWN_TYPE_NAMES, SHUTDOWN_TYPE_TEXT, SHUTDOWN_WIDTH, encodeShutdownPicture, factoryShutdownJpegs, installShutdownMenu, readShutdownJpegs, readShutdownMenu, shutdownPath, shutdownThumbnail, validateShutdownName } from './shutdown';
export type { ShutdownPictureSpec } from './shutdown';
export { findResInsertion, readRes, resFile } from './res';
export { Patch } from './build';
export { HALATION, HALATION_COLOUR_NAMES, HALATION_NAMES, halateRgba, halateYcc, halationColourIcon, halationColourScale, halationGains, halationIcon, halationLight, halationLut, paramBytes, PLAIN_LIGHT, readHalation, readHalationLight } from './halation';
export type { HalationColour, HalationLevel } from './halation';
export type { HalationLight, HalationLook } from './halation';
