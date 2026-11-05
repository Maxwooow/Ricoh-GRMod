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
export { DATESTAMP_AS_STORED, DATESTAMP_BYTE, DATESTAMP_LONG, DATESTAMP_NAME, DATESTAMP_ON, FACTORY_LOOK_NAMES, JPEG_EXECUTE, LETTER_SEGMENTS, LOOK_NAME_MAX, datestampModule, installDateStamp, lookNameGlyphs, lookNames } from './datestamp';
export { DATESTAMP_ICON_IDS, DATESTAMP_MENU_ID, DATESTAMP_NAME_WORDS, DATESTAMP_ORIENT_ID, DATESTAMP_ORIENT_NAMES, DATESTAMP_STYLE_ID, DATESTAMP_SWITCH_ID, DATESTAMP_TEXT_IDS, datestampNameTexts, drawStyleIcon, installDateStampMenu } from './datestamp-menu';
export { CINEMA_STYLES, EXTRA_FIRST_STYLE, EXTRA_ICON_BYTES, EXTRA_ICON_ID, EXTRA_NAME_MAX, EXTRA_TEXT_ID, MAX_EXTRA_SLOTS, extraIconId, extraTextId, installExtraSlots, installHalation, readExtraSlots, validateExtraSlotName } from './slots';
export { COLOR_CONDITIONAL, COLOR_HIDDEN, COLOR_VIS_TABLE, COLOR_VISIBLE, EXTRA_LOOK_FIRST, FACTORY_LOOK_IDS, MONO_HIDDEN, MONO_VIS_TABLE, ORDER_COUNT, ORDER_TABLE, installFactoryHidden, installLookOrder, lookLayoutWords, validateLookLayout } from './looks';
export type { LookLayout } from './looks';
export type { ExtraSlotSpec } from './slots';
export { FACTORY_PICTURES, PREVIEW_HEIGHT, PREVIEW_WIDTH, SHUTDOWN_HEIGHT, SHUTDOWN_ICON_ID, SHUTDOWN_JPEG_BYTES, SHUTDOWN_MAX_PICTURES, SHUTDOWN_NAME_MAX, SHUTDOWN_FACTORY_TEXT, SHUTDOWN_MENU_ID, SHUTDOWN_PICTURE_ID, SHUTDOWN_PICTURE_NAMES, SHUTDOWN_PICTURE_TEXT, SHUTDOWN_RECORD, SHUTDOWN_TEXT_ID, SHUTDOWN_TYPE_NAMES, SHUTDOWN_TYPE_TEXT, SHUTDOWN_WIDTH, encodeShutdownPicture, factoryShutdownJpegs, installShutdownMenu, readShutdownJpegs, readShutdownMenu, shutdownPath, shutdownThumbnail, validateShutdownName } from './shutdown';
export type { ShutdownPictureSpec } from './shutdown';
export { findResInsertion, readRes, resFile } from './res';
export { Patch } from './build';
export { HALATION, HALATION_COLOUR_NAMES, HALATION_NAMES, halateRgba, halateYcc, halationColourIcon, halationColourScale, halationGains, halationIcon, halationLight, halationLut, paramBytes, PLAIN_LIGHT, readHalation, readHalationLight } from './halation';
export type { HalationColour, HalationLevel } from './halation';
export type { HalationLight, HalationLook } from './halation';
export { LOOK_STASH, ORIENT_VALID, ORIENT_WORD, STASH_WHITE } from './lookstash';
export { DIRECT_FLASH_BYTE, DIRECT_FLASH_GN_BYTE, DIRECT_FLASH_TV_BYTE, DIRECT_FLASH_GN_DEFAULT, DIRECT_FLASH_ICON_ID, DIRECT_FLASH_NAMES, DIRECT_FLASH_TEXT_ID, drawDirectFlashIcon, guideNumberWord, installDirectFlash } from './directflash';
export {
  DF_BACKGROUND_ID, DF_BACKGROUND_NAMES, DF_BACKGROUND_THIRDS, DF_GN_ID, DF_GN_NAMES, DF_GUIDE_NUMBERS, DF_ICON_ID, DF_LOW_ISO_NAMES, DF_MAX_SYNC_NAMES,
  DF_MENU_ID, DF_MENU_NAMES, DF_PRIORITY_ID, DF_PRIORITY_NAMES, DF_SLOWEST, DF_SLOWEST_ID, DF_TEXT_ID, DF_FASTEST, DF_FASTEST_ID, DF_FASTEST_NAMES, DF_FASTEST_TEXT_ID, DF_SYNC_LIMIT_NAMES, directFlashLists, drawValueIcon, installDirectFlashMenu,
} from './directflash-menu';
