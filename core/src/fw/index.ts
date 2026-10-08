/** Public API of the firmware toolchain (GR IV firmware 1.11). */
export { FirmwareError } from './types';
export type { Range } from './types';

export {
  HDR,
  MAGIC,
  Firmware,
  FRAME_SIZE,
  build,
  buildGrown,
  equalRange,
  parseFrames,
  sectionData,
  sectionSums,
  sectionsOf,
  sha256Hex,
  sum32,
  verifyContainer,
  wrapStream,
} from './container';
export type { BuildOutput, Frame, Insertion, ParseResult, Section, VerifyResult } from './container';

export {
  COMP_OFFSET,
  COMP_VA,
  DECODED_SHA256,
  DECODED_SIZE,
  EXPECTED_SLOT_INFO,
  EXPECTED_STANDARD_MA_BLOCK,
  FIRMWARE_VERSION,
  ICONBIN_LENGTH,
  ICONBIN_OFFSET,
  ICON_BYTES,
  LEN,
  NEGA_ICON_OFFSET,
  OFFICIAL_SHA256,
  OFFICIAL_SIZE,
  RAM_IMAGE_VA,
  RAM_LENGTH,
  RAM_VA,
  RTOS_LENGTH,
  RTOS_OFFSET,
  RTOS_VA,
  SLOTS,
  TABLE_ENTRIES,
  TABLE_VARIANTS,
  TONE_CINEMA_GREEN,
  TONE_CINEMA_YELLOW,
  TONE_STANDARD,
  T_GAM,
  T_MA,
  T_REC,
  foff,
  openOfficial,
  resolveLayout,
  slotDef,
  slotInfo,
} from './profile';
export type { Layout, SlotDef, SlotId, SlotInfo } from './profile';

export { LANGS, NAME_TABLE_ENTRIES, NAME_TABLE_RTOS_OFFSETS, allowedChars, applyName, nameRanges, readName, validateName } from './names';
export type { LangCode, NameInfo, NameValidation } from './names';

export { CONTENT_AREA, ICON_H, ICON_W, TILE_BG, TILE_BORDER, composeIcon, normalizeIcon, readIcon, tileTemplate } from './icons';
export type { TileStyle } from './icons';

export { buildFirmware, editableRanges } from './patch';

export { CLARITY_BANDS, CLARITY_BYTES, CLARITY_GAIN_MAX, CLARITY_OFFSET, CLARITY_ROWS, CLARITY_VA, OFFICIAL_CLARITY, SOFT_FOCUS_GAINS, SOFT_FOCUS_LEVELS, SOFT_FOCUS_STRENGTHS, clarityBytes, clarityChanges, hasOfficialClarity, readClarity } from './clarity';
export type { ClarityChange, ClarityEdit, SoftFocusLevel, SoftFocusStrength } from './clarity';
export type { BuildResult, BuiltRatio, ColorData, SlotEdit } from './patch';

export { SELF_CHECK_GROWN_NAMES, SELF_CHECK_NAMES, countChangedBytes, selfCheck, selfCheckGrown } from './selfcheck';

export { findResource, listResources } from "./resources";
export type { ResourceFile } from "./resources";

export { modeSetKeywords, readFactoryEntry } from './factory';
export type { FactoryEntry } from './factory';

export * as aspect from './aspect';
export { MAX_CUSTOM_RATIOS, MAX_NAME_LENGTH, gr4Sizes, planRatio, planRatios, ratioText, validateRatioName } from './aspect';
export type { RatioEntry, RatioGeometry, RatioSpec } from './aspect';
export { readBuildRevision, readRatioRecord } from './aspect/package';
