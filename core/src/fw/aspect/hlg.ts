// SPDX-License-Identifier: GPL-2.0-only
/**
 * BT.2100 HLG HDR Still Photography mod for Ricoh GR IV (firmware 1.11).
 *
 * Transforms the camera's "HDR Tone" (HDR色调, toneId = 22 = 0x16) image control slot into
 * an in-camera direct BT.2100 HLG HDR photo capture mode:
 *  1. Dedicated ToneRecord: points to a signed int16 Q13 (8192 = 1.0) linear color matrix
 *     converting Rec.709 sensor primaries to Rec.2020 WCG (M_709_to_2020 @ M_STD).
 *  2. Gamma Descriptor: passes the 256-point 14-bit (0..16383) ARIB STD-B67 curve with S^-1
 *     pre-compensation to bypass camera base tone curve distortion, and sets desc[5] = 0.
 *  3. Neutral Multi-Axis Table: T_MA[22] repointed to Standard's neutral maBlock (0x54049DE8).
 *  4. Slot Name: "HDR" across all 21 UI languages (Text ID 306).
 *  5. Slot Icon: Retains the camera's official HDR Tone icon in ICONBIN (0 byte overhead in ICONBIN).
 *  6. In-Camera Automatic APP2 CICP ICC Profile Injection:
 *     Hooks ExifJpegWriter::SetupAppNInfo at 0x5380BF50.
 *     When the active photo toneId is 22, it injects a 32-byte aligned APP2 segment
 *     (len = 576 = 0x240) with ICC_PROFILE header and BT.2100 HLG CICP [9, 18, 0, 1] color profile, advancing
 *     the JPEG workArea buffer so every JPEG saved is recognized as native HDR on Apple (iPhone/Mac),
 *     Windows HDR, Android, and Chromium platforms.
 *  7. HDR Tone Level 0 Option, Scale Track 0x23D & Filter Bypass:
 *     Repoints the slider track scale graphic from 0x23B (3-step bars [1, 2, 3]) to 0x23D
 *     (Ricoh's official 3-step scale with [OFF, 1-bar, 2-bars] rasterized icons).
 *     Maps options 0..2 to internal values [0, 1, 2] across all HDR cuisine profile mapping tables.
 *     When level is dialed down to 0 (OFF), the camera's internal pipeline natively bypasses the HDR Tone
 *     filter effect (setting tone mapping strength to 0 and active flag to 0) while maintaining
 *     full BT.2100 HLG HDR capture (Rec.2020 matrix, ARIB STD-B67 curve, and APP2 CICP ICC profile).
 *     Dialing level to 1 (1-bar) or 2 (2-bars) applies varying intensity of local tone compression.
 */
import { FirmwareError } from '../types';
import { BASE, Patch, expectWord, u32le } from './build';
import { branchWord } from './arm';
import { HLG_CURVE_B64, HLG_HOOK_B64, HLG_ICC_B64, HLG_MATRIX_B64 } from './hlg-data';

export const TARGET_TONE_ID = 22; // HDR Tone
export const TARGET_TEXT_ID = 306; // Index 306 in text tables
export const HOOK_SITE = 0x5380bf50; // ExifJpegWriter::SetupAppNInfo

// Scale graphic IDs: 0x23b = 3-step [1, 2, 3] signal bars, 0x23d = 3-step [OFF, 1, 2]
export const HDR_SCALE_SHOOTING = 0x531c8c34; // Shooting mode detail line slider scale
export const HDR_SCALE_PLAYBACK = 0x531cc27c; // Playback / RAW development detail line slider scale

// HDR Tone Level (HDR Intense) tables and UI control sites:
export const HDR_INTENSE_TABLE_0 = 0x53dbaed4; // HDR intense value mapping table (cuisine 0)
export const HDR_INTENSE_TABLE_1 = 0x53dbacc4; // HDR intense value mapping table (cuisine 1)
export const HDR_INTENSE_TABLE_2 = 0x53dbaecc; // HDR intense value mapping table (cuisine 2)
export const HDR_INTENSE_TABLE_3 = 0x53dbad84; // HDR intense value mapping table (cuisine 3)
export const HDR_INTENSE_TABLE = HDR_INTENSE_TABLE_3; // backwards compatibility

export const HDR_INTENSE_COUNT_CMP = 0x533bec24; // GetHdrCuisineHdrIntenseValueCount: cmp r0, #3
export const HDR_INTENSE_COUNT_MOV = 0x533bec28; // GetHdrCuisineHdrIntenseValueCount: movls r0, #3
export const HDR_INTENSE_ASCII_CMP = 0x5339b610; // GetImageControlParameterHdrIntenseAscii: beq #0x5339b64c

// Secondary & Raw Development formatters (0x5339b6a4 and 0x5339b75c)
export const HDR_FORMATTER1_MOV = 0x5339b6b0; // moveq r3, #2 -> mov r3, r2
export const HDR_FORMATTER1_B = 0x5339b6c0; // beq 0x5339b6d8 -> b 0x5339b6d8
export const HDR_FORMATTER2_MOV = 0x5339b768; // moveq r3, #2 -> mov r3, r2
export const HDR_FORMATTER2_B = 0x5339b778; // beq 0x5339b790 -> b 0x5339b790

export const STD_REC_VA = 0x5501adbc;
export const STD_MA_DESC_VA = 0x54049de8;
export const T_REC_BASE = 0x55053780;
export const T_GAM_BASE = 0x55053138;
export const T_MA_BASE = 0x55053504;
export const NATIVE_TEXT_ROOTS = 0x55002118;
export const TEXT_CATALOG = 0x543d4ac0;
export const LANGUAGES = 21;

const RAM_DEST = 0x55000000;
const RAM_SRC = 0x5437b640;
const RAM_LEN = 0x57480;

function b64decode(s: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const buf: number[] = [];
  let bits = 0; let v = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '=') break;
    const idx = chars.indexOf(c);
    if (idx === -1) continue;
    v = (v << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      buf.push((v >> bits) & 0xff);
    }
  }
  return new Uint8Array(buf);
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export const HLG_MATRIX = b64decode(HLG_MATRIX_B64);
export const HLG_CURVE = b64decode(HLG_CURVE_B64);
export const HLG_ICC = b64decode(HLG_ICC_B64);
export const HLG_HOOK = b64decode(HLG_HOOK_B64);

/** 14B header + 532B ICC + 2B zero pad = 548B (137 words) */
export const HLG_APP2_DATA = concat([ascii('ICC_PROFILE\0\x01\x01'), HLG_ICC, new Uint8Array(2)]);
/** 176B hook + 548B APP2 data = 724 bytes */
export const HLG_HOOK_BLOCK = concat([HLG_HOOK, HLG_APP2_DATA]);

/** Maps a runtime RAM VA (0x55000000..0x55057480) to its ROM image address (0x5437b640..) for Patch writes */
export function romVa(va: number): number {
  if (va >= RAM_DEST && va < RAM_DEST + RAM_LEN) {
    return RAM_SRC + (va - RAM_DEST);
  }
  return va;
}

/**
 * Install the BT.2100 HLG Photo modification into a growable RTOS image (`Patch`).
 */
export function installHlgPhoto(patch: Patch): void {
  // 1. Verify official hook sites and instructions
  expectWord(patch, HOOK_SITE, 0xe24bd014); // sub sp, fp, #0x14
  expectWord(patch, HDR_SCALE_SHOOTING, 0xe300323b); // movw r3, #0x23b
  expectWord(patch, HDR_SCALE_PLAYBACK, 0xe300323b); // movw r3, #0x23b
  expectWord(patch, HDR_INTENSE_TABLE_0, 0x00030201); // [1, 2, 3, 0]
  expectWord(patch, HDR_INTENSE_TABLE_1, 0x00030201); // [1, 2, 3, 0]
  expectWord(patch, HDR_INTENSE_TABLE_2, 0x00030201); // [1, 2, 3, 0]
  expectWord(patch, HDR_INTENSE_TABLE_3, 0x00030201); // [1, 2, 3, 0]
  expectWord(patch, HDR_INTENSE_COUNT_CMP, 0xe3500003); // cmp r0, #3
  expectWord(patch, HDR_INTENSE_COUNT_MOV, 0x93a00003); // movls r0, #3
  expectWord(patch, HDR_INTENSE_ASCII_CMP, 0x0a00000d); // beq #0x5339b64c
  expectWord(patch, HDR_FORMATTER1_MOV, 0x03a03002); // moveq r3, #2
  expectWord(patch, HDR_FORMATTER1_B, 0x0a000004); // beq 0x5339b6d8
  expectWord(patch, HDR_FORMATTER2_MOV, 0x03a03002); // moveq r3, #2
  expectWord(patch, HDR_FORMATTER2_B, 0x0a000004); // beq 0x5339b790

  // 2. Append HLG Tone Curve (256 uint16 = 512 bytes, 256-byte aligned)
  const curveVa = patch.append(HLG_CURVE, 256);

  // 3. Append Gamma Descriptor (20 bytes): [0x5407DEF4, 1, curveVa, curveVa, curveVa]
  const gamDescVa = patch.append(u32le([0x5407def4, 1, curveVa, curveVa, curveVa]), 4);

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
  // Repoint slider track scale graphic to 0x23D (Ricoh native 3-step scale with [OFF, 1-bar, 2-bars] icons)
  patch.setWord(HDR_SCALE_SHOOTING, 0xe300323d, 'HLG photo: HDR tone level scale 0x23d (shooting)');
  patch.setWord(HDR_SCALE_PLAYBACK, 0xe300323d, 'HLG photo: HDR tone level scale 0x23d (playback/raw)');

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
}
