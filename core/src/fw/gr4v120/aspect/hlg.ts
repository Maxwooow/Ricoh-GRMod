// SPDX-License-Identifier: GPL-2.0-only
/**
 * BT.2100 HLG HDR Still Photography mod for Ricoh GR IV (firmware 1.20).
 *
 * Transforms the camera's "HDR Tone" (HDR色调, toneId = 22 = 0x16) image control slot into
 * an in-camera direct BT.2100 HLG HDR photo capture mode:
 *  1. Dedicated ToneRecord: points to a signed int16 Q13 (8192 = 1.0) linear color matrix
 *     converting Rec.709 sensor primaries to Rec.2020 WCG (M_709_to_2020 @ M_STD).
 *  2. Gamma Descriptor: passes the 256-point 14-bit (0..16383) ARIB STD-B67 curve with S^-1
 *     pre-compensation to bypass camera base tone curve distortion, and sets desc[5] = 0.
 *  3. Neutral Multi-Axis Table: T_MA[22] repointed to Standard's neutral maBlock (0x54081348).
 *  4. Slot Name: "HDR" across all 21 UI languages (Text ID 323).
 *  5. Slot Icon: Retains the camera's official HDR Tone icon in ICONBIN (0 byte overhead in ICONBIN).
 *  6. In-Camera Automatic APP2 CICP ICC Profile Injection:
 *     Hooks ExifJpegWriter::SetupAppNInfo at 0x53832B60.
 *     When the active photo toneId is 22, it injects a 32-byte aligned APP2 segment
 *     (len = 576 = 0x240) with ICC_PROFILE header and BT.2100 HLG CICP [9, 18, 0, 1] color profile, advancing
 *     the JPEG workArea buffer so every JPEG saved is recognized as native HDR on Apple (iPhone/Mac),
 *     Windows HDR, Android, and Chromium platforms.
 *  7. HDR Tone Level 0 Option, Custom Scale Track & Filter Bypass:
 *     Installs a custom 3-step scale graphic (ID 800) derived from the native 400x60 scale 0x261,
 *     with rasterized icons:
 *       - Level 0 (cx = 20): Official Ricoh "OFF" icon borrowed directly from native Toning scale 0xD2
 *       - Level 1 (cx = 200): 1-bar icon
 *       - Level 2 (cx = 380): 2-bars icon
 *     Maps options 0..2 to internal values [0, 1, 2] across all HDR cuisine profile mapping tables.
 *     When level is dialed down to 0 (OFF), the camera's internal pipeline natively bypasses the HDR Tone
 *     filter effect (setting tone mapping strength to 0 and active flag to 0) while maintaining
 *     full BT.2100 HLG HDR capture (Rec.2020 matrix, ARIB STD-B67 curve, and APP2 CICP ICC profile).
 *     Dialing level to 1 (1-bar) or 2 (2-bars) applies varying intensity of local tone compression.
 */
import { FirmwareError } from '../../types';
import { BASE, ICON_CATALOG, LOOKUP_BOUNDS, Patch, concat, expectWord, u16le, u32le } from './build';
import { branchWord, movImmediate, movWord } from './arm';
import { HLG_CURVE, HLG_HOOK_BLOCK, HLG_MATRIX, createHdrScale } from '../../aspect/hlg';

export const TARGET_TONE_ID = 22; // HDR Tone
export const TARGET_TEXT_ID = 323; // Index 323 in 1.20 text tables (1.11 was 306)
export const HOOK_SITE = 0x53832b60; // ExifJpegWriter::SetupAppNInfo (1.11 was 0x5380bf50)

// Scale graphic IDs: 0x261 = native 3-step [1, 2, 3] in 1.20 (1.11 was 0x23b)
// 0xd2 = native 3-step toning scale with official Ricoh OFF icon in 1.20 (1.11 was 0xc4)
// 800 = custom 3-step [OFF, 1, 2] in 1.20
export const HDR_SCALE_ICON_ID = 800;
const NATIVE_SCALE_ICON = 0x261;
const NATIVE_TONING_SCALE_ICON = 0xd2;
export const HDR_SCALE_SHOOTING = 0x531ca1e0; // Shooting mode detail line slider scale (1.11 was 0x531c8c34)
export const HDR_SCALE_PLAYBACK = 0x531cda58; // Playback / RAW development detail line slider scale (1.11 was 0x531cc27c)

// HDR Tone Level (HDR Intense) tables and UI control sites in 1.20:
export const HDR_INTENSE_TABLE_0 = 0x53de573c; // cuisine 0 (1.11 was 0x53dbaed4)
export const HDR_INTENSE_TABLE_1 = 0x53de551c; // cuisine 1 (1.11 was 0x53dbacc4)
export const HDR_INTENSE_TABLE_2 = 0x53de5734; // cuisine 2 (1.11 was 0x53dbaecc)
export const HDR_INTENSE_TABLE_3 = 0x53de55f0; // cuisine 3 (1.11 was 0x53dbad84)
export const HDR_INTENSE_TABLE = HDR_INTENSE_TABLE_3;

export const HDR_INTENSE_COUNT_CMP = 0x533cfa34; // GetHdrCuisineHdrIntenseValueCount: cmp r0, #3 (1.11 was 0x533bec24)
export const HDR_INTENSE_COUNT_MOV = 0x533cfa38; // GetHdrCuisineHdrIntenseValueCount: movls r0, #3 (1.11 was 0x533bec28)
export const HDR_INTENSE_ASCII_CMP = 0x533aacc8; // GetImageControlParameterHdrIntenseAscii: beq #... (1.11 was 0x5339b610)

// Secondary & Raw Development formatters (0x533aad5c and 0x533aae14 in 1.20)
export const HDR_FORMATTER1_MOV = 0x533aad68; // moveq r3, #2 -> mov r3, r2 (1.11 was 0x5339b6b0)
export const HDR_FORMATTER1_B = 0x533aad78; // beq 0x533aad90 -> b 0x533aad90 (1.11 was 0x5339b6c0)
export const HDR_FORMATTER2_MOV = 0x533aae20; // moveq r3, #2 -> mov r3, r2 (1.11 was 0x5339b768)
export const HDR_FORMATTER2_B = 0x533aae30; // beq 0x533aae48 -> b 0x533aae48 (1.11 was 0x5339b778)

export const STD_REC_VA = 0x5501c118; // 1.11 was 0x5501adbc
export const STD_MA_DESC_VA = 0x54081348; // 1.11 was 0x54049de8
export const T_REC_BASE = 0x55054800; // 1.11 was 0x55053780
export const T_GAM_BASE = 0x55054158; // 1.11 was 0x55053138
export const T_MA_BASE = 0x55054554; // 1.11 was 0x55053504
export const NATIVE_TEXT_ROOTS = 0x55002118;
export const TEXT_CATALOG = 0x5440da00; // 1.11 was 0x543d4ac0
export const LANGUAGES = 21;

const RAM_DEST = 0x55000000;
const RAM_SRC = 0x543b3100; // 1.11 was 0x5437b640
const RAM_LEN = 0x58500; // 1.11 was 0x57480
const GAMMA_DESC_WORD0 = 0x540b4da0; // 1.11 was 0x5407def4

/** Maps a runtime RAM VA (0x55000000..0x55058500) to its ROM image address (0x543b3100..) for Patch writes */
export function romVa(va: number): number {
  if (va >= RAM_DEST && va < RAM_DEST + RAM_LEN) {
    return RAM_SRC + (va - RAM_DEST);
  }
  return va;
}

/**
 * Install the BT.2100 HLG Photo modification into a growable RTOS image (`Patch`)
 * and ICONBIN payload (`iconbin`) for GR IV firmware 1.20.
 */
export function installHlgPhoto(patch: Patch, iconbin: Uint8Array): Uint8Array {
  // 1. Verify official hook sites and instructions
  expectWord(patch, HOOK_SITE, 0xe24bd014); // sub sp, fp, #0x14
  expectWord(patch, HDR_SCALE_SHOOTING, 0xe3003261); // movw r3, #0x261
  expectWord(patch, HDR_SCALE_PLAYBACK, 0xe3003261); // movw r3, #0x261
  expectWord(patch, HDR_INTENSE_TABLE_0, 0x00030201); // [1, 2, 3, 0]
  expectWord(patch, HDR_INTENSE_TABLE_1, 0x00030201); // [1, 2, 3, 0]
  expectWord(patch, HDR_INTENSE_TABLE_2, 0x00030201); // [1, 2, 3, 0]
  expectWord(patch, HDR_INTENSE_TABLE_3, 0x00030201); // [1, 2, 3, 0]
  expectWord(patch, HDR_INTENSE_COUNT_CMP, 0xe3500003); // cmp r0, #3
  expectWord(patch, HDR_INTENSE_COUNT_MOV, 0x93a00003); // movls r0, #3
  expectWord(patch, HDR_INTENSE_ASCII_CMP, 0x0a00000d); // beq #0x533aad04
  expectWord(patch, HDR_FORMATTER1_MOV, 0x03a03002); // moveq r3, #2
  expectWord(patch, HDR_FORMATTER1_B, 0x0a000004); // beq 0x533aad90
  expectWord(patch, HDR_FORMATTER2_MOV, 0x03a03002); // moveq r3, #2
  expectWord(patch, HDR_FORMATTER2_B, 0x0a000004); // beq 0x533aae48

  // 2. Append HLG Tone Curve (256 uint16 = 512 bytes, 256-byte aligned)
  const curveVa = patch.append(HLG_CURVE, 256);

  // 3. Append Gamma Descriptor (20 bytes): [GAMMA_DESC_WORD0, 1, curveVa, curveVa, curveVa]
  const gamDescVa = patch.append(u32le([GAMMA_DESC_WORD0, 1, curveVa, curveVa, curveVa]), 4);

  // 4. Append Q13 Rec.2020 Color Correction Matrix (18 bytes)
  const matrixVa = patch.append(HLG_MATRIX, 4);

  // 5. Append Dedicated ToneRecord (84 bytes, copied from Standard with matrix pointer updated)
  const stdRec = patch.readMapped(STD_REC_VA, 84);
  const recBytes = new Uint8Array(stdRec);
  new DataView(recBytes.buffer, recBytes.byteOffset, recBytes.byteLength).setUint32(4, matrixVa, true);
  const recVa = patch.append(recBytes, 4);

  // 6. Append UTF-16LE "HDR\0" string (8 bytes) and descriptor struct (8 bytes)
  const hdrStr = new Uint8Array([0x48, 0x00, 0x44, 0x00, 0x52, 0x00, 0x00, 0x00]);
  const textVa = patch.append(hdrStr, 4);
  const textDescVa = patch.append(concat([Uint8Array.from([4, 1, 0, 0]), u32le([textVa])]), 4);

  // 7. Append Hook Code + APP2 ICC Payload (724 bytes, 16-byte aligned)
  const hookVa = patch.append(HLG_HOOK_BLOCK, 16);

  // 8. Hook SetupAppNInfo to branch to hookVa
  patch.setWord(HOOK_SITE, branchWord(HOOK_SITE, hookVa), 'HLG photo: APP2 injection hook');

  // 9. Enable Level 0 in HDR Tone Level (HDR Intense) parameters:
  // Render custom 3-step scale graphic [0: OFF (official icon), 1: 1-bar, 2: 2-bars]
  const nativeScale = new DataView(patch.readMapped(ICON_CATALOG + NATIVE_SCALE_ICON * 4, 4).buffer).getUint32(0, true);
  const scaleAt = new DataView(patch.readMapped(nativeScale + 8, 4).buffer).getUint32(0, true) * 4;
  const native = iconbin.slice(scaleAt, scaleAt + 400 * 60 * 4);

  const nativeToning = new DataView(patch.readMapped(ICON_CATALOG + NATIVE_TONING_SCALE_ICON * 4, 4).buffer).getUint32(0, true);
  const toningAt = new DataView(patch.readMapped(nativeToning + 8, 4).buffer).getUint32(0, true) * 4;
  const toning = iconbin.slice(toningAt, toningAt + 400 * 60 * 4);

  const scalePixels = createHdrScale(native, toning);

  // Pad and append to iconbin, register in ICON_CATALOG
  const pad = (4 - (iconbin.length % 4)) % 4;
  const iconOffset = iconbin.length + pad;
  expectWord(patch, ICON_CATALOG + HDR_SCALE_ICON_ID * 4, 0);
  const descriptorVa = patch.append(concat([u16le([1, 400, 60, 0]), u32le([iconOffset / 4])]), 16);
  patch.setWord(ICON_CATALOG + HDR_SCALE_ICON_ID * 4, descriptorVa, 'HLG photo: HDR tone scale descriptor');

  // Update lookup bounds so GetIconDescriptor accepts HDR_SCALE_ICON_ID
  for (const [site, r] of LOOKUP_BOUNDS) {
    patch.setWord(site, movWord(r, Math.max(HDR_SCALE_ICON_ID, movImmediate(patch.word(site)))), 'icon upper bound');
  }

  // Repoint slider track scale graphic to HDR_SCALE_ICON_ID
  patch.setWord(HDR_SCALE_SHOOTING, movWord(3, HDR_SCALE_ICON_ID), 'HLG photo: HDR tone level scale (shooting)');
  patch.setWord(HDR_SCALE_PLAYBACK, movWord(3, HDR_SCALE_ICON_ID), 'HLG photo: HDR tone level scale (playback/raw)');

  // Map internal values [0, 1, 2, 0] for options 0..2 across all 4 HDR cuisine profile tables
  patch.setWord(HDR_INTENSE_TABLE_0, 0x00020100, 'HLG photo: HDR tone intense table 0 [0, 1, 2, 0]');
  patch.setWord(HDR_INTENSE_TABLE_1, 0x00020100, 'HLG photo: HDR tone intense table 1 [0, 1, 2, 0]');
  patch.setWord(HDR_INTENSE_TABLE_2, 0x00020100, 'HLG photo: HDR tone intense table 2 [0, 1, 2, 0]');
  patch.setWord(HDR_INTENSE_TABLE_3, 0x00020100, 'HLG photo: HDR tone intense table 3 [0, 1, 2, 0]');

  // Allow formatting "0".."3" in GetImageControlParameterHdrIntenseAscii (Menu & LiveView)
  patch.setWord(HDR_INTENSE_ASCII_CMP, 0x9a00000d, 'HLG photo: intense ascii bls (allow 0..3)');

  // Direct formatting r3 = r2 in secondary/RAW development formatters (allows 0..3 without clamping or crash)
  patch.setWord(HDR_FORMATTER1_MOV, 0xe1a03002, 'HLG photo: formatter 1 mov r3, r2');
  patch.setWord(HDR_FORMATTER1_B, 0xea000004, 'HLG photo: formatter 1 b format');
  patch.setWord(HDR_FORMATTER2_MOV, 0xe1a03002, 'HLG photo: formatter 2 mov r3, r2');
  patch.setWord(HDR_FORMATTER2_B, 0xea000004, 'HLG photo: formatter 2 b format');

  // 10. Repoint T_REC[22] -> recVa
  patch.setWord(romVa(T_REC_BASE + TARGET_TONE_ID * 4), recVa, 'HLG photo: tone record');

  // 11. Repoint T_GAM[22] -> gamDescVa
  patch.setWord(romVa(T_GAM_BASE + TARGET_TONE_ID * 4), gamDescVa, 'HLG photo: gamma descriptor');

  // 12. Repoint T_MA[22] -> Standard neutral multi-axis table
  patch.setWord(romVa(T_MA_BASE + TARGET_TONE_ID * 4), STD_MA_DESC_VA, 'HLG photo: neutral multi-axis table');

  // 13. Update slot name to "HDR" across all 21 languages
  for (let l = 0; l < LANGUAGES; l++) {
    // Native ROM image of text root row:
    const nativeRow = new DataView(patch.readMapped(NATIVE_TEXT_ROOTS + l * 4, 4).buffer).getUint32(0, true);
    patch.setWord(romVa(nativeRow + TARGET_TEXT_ID * 4), textDescVa, `HLG photo: UI label HDR (lang ${l})`);

    // Relocated extended text catalog (if scaffold was initialized):
    if (patch.length > TEXT_CATALOG - BASE) {
      const extRow = patch.word(TEXT_CATALOG + l * 4);
      if (extRow) {
        patch.setWord(extRow + TARGET_TEXT_ID * 4, textDescVa, `HLG photo: UI label HDR in extended catalog (lang ${l})`);
      }
    }
  }

  return concat([iconbin, new Uint8Array(pad), scalePixels]);
}
