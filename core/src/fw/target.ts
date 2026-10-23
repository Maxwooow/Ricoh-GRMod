// SPDX-License-Identifier: GPL-2.0-only
/**
 * The official firmware files this program builds on.
 *
 *  - 1.11: fwdc248b.bin of GR IV / GR IV HDF 1.11 (2026/02/13). Its container also carries the
 *    model record of the GR IV Monochrome, as version 1.00: the Monochrome came out the same day
 *    on this build. Everything in this program was first written for this file.
 *  - 1.20: fwdc248b.bin of GR IV / GR IV HDF 1.20 and, byte for byte the same file, of GR IV
 *    Monochrome 1.10 (2026/10/21; gr4_v120.zip and gr4_mono_v110.zip hold the same file). Each
 *    model record names the version that model shows: 1.20.10.11 for the GR IV and HDF,
 *    1.10.10.4 for the Monochrome.
 *
 * 1.20 is the same program as 1.11 rebuilt with additions (Solarized Effect, AF point memory,
 * USER mode restore, connection while off, ...), so nearly everything this program changes is
 * still there, at other addresses. The patcher is written with the 1.11 addresses it was found
 * at; each one goes through `va()`, which is the identity for 1.11 and a table for 1.20
 * (`target120.ts`): every entry located in 1.20 by matching the two files' code and data, and
 * checked (tools/port120/). An address the table does not hold is an error, never a guess. What
 * is not an address but still differs (counts, record sizes, the place of a field) is in `facts`.
 *
 * The colour work (Cinema slot edits, the clarity table, the monochrome looks, added Image
 * Control slots and their halation) is for 1.11 only: 1.20 added an Image Control and rebuilt the
 * style tables it relies on. Of the additions, aspect ratios, soft focus on the ADJ lever, the
 * date imprint and the power-off pictures are there for both; that is everything that applies to
 * the GR IV Monochrome.
 */
import { FirmwareError } from './types';
import { VA_120 } from './target120';

export type TargetId = '1.11' | '1.20';
/** Camera models, as `CameraModel` of `wallpaper/`. */
export type TargetModel = 'STANDARD' | 'HDF' | 'MONO';

export interface TargetFacts {
  /** Number of icons in the camera's icon catalog. */
  iconCount: number;
  /** Number of texts per language. */
  textCount: number;
  /** Language tables: the first one in the RAM image, and the distance between two. */
  firstTextTable: number;
  textTableStride: number;
  /** Width (texts) of the relocated language rows; this program's texts are below it. */
  textCapacity: number;
  /** Text numbers of the factory ratios' names (identities 0..3). */
  ratioTexts: readonly [number, number, number, number];
  /** Text numbers of this program's own texts. */
  texts: {
    softFocus: number;
    dateStamp: { name: number; onOff: number; style: number; short: number; long: number; orient: number };
    /** Power-off pictures: "Type", "Picture", the factory row, then the pictures' names. */
    shutdown: number;
  };
  /** Size of the user settings (UserData) structure. */
  userDataSize: number;
  /** The live UserData object (its settings start 4 bytes in). */
  userData: number;
  /**
   * How far the fields from 0x320 on of the live-view rectangle object (the one of the tracking
   * hooks, 0x5364DCB0) moved: 0 in 1.11, 0x14 in 1.20.
   */
  liveViewShift: number;
  /** How the two icon-number bounds are compared: MOVW of the bound (1.11) or CMP with an immediate (1.20). */
  iconBoundForm: 'movw' | 'cmp';
  /**
   * End of the start-up zero fill (BSS) and start of the heap: 44 bytes apart in both files, and
   * nothing refers to the bytes in between (tools/port120/: no pointer, no MOVW/MOVT pair).
   */
  bssEnd: number;
  heap: number;
  /** The camera's own texts and icons this program uses (their numbers moved in 1.20). */
  camera: {
    texts: { on: number; off: number; low: number; medium: number; high: number; flashComp: number; endScreen: number; dRange: number; horizon: number; reset: number };
    icons: { off: number; on: number };
  };
  /** Records of the list (SelectMenuController) and submenu (SubMenuController) tables. */
  listRecords: number;
  submenuRecords: number;
  /** Entries of the table of full-screen JPEGs (1.20 adds GB_30th.jpg). */
  jpegCount: number;
  /** Decoded offsets of the 40x40 icons the icon tiles are drawn from: Nega and Cinema (Yellow). */
  tileIcons: { nega: number; cinemaYellow: number };
  /**
   * The camera's own looks (Image Controls) are 0 .. looks - 1, the numbers its look-name switch
   * (0x5337F824) knows: 31 in 1.11; 33 in 1.20, which adds Pictorialist Effect (31) and Solarized
   * Effect (32, "Added the [Solarized Effect] Image Control" in the Monochrome's 1.10 notes).
   */
  looks: number;
  /**
   * The camera's own black-and-white looks: Monotone, Soft Monotone, Hard Monotone, Hi-Contrast
   * B&W (13..16) and the Monochrome's own (25..30; in 1.20 also 31 and 32).
   */
  monoLooks: readonly number[];
}

export interface FirmwareTarget {
  readonly id: TargetId;
  /** The version each camera model shows with this file (its container's model records). */
  readonly versions: Readonly<Record<TargetModel, string>>;
  readonly officialSha256: string;
  readonly officialSize: number;
  readonly decodedSha256: string;
  readonly decodedSize: number;
  /** RTOS section: data offset in the decoded payload and length; loaded at 0x53000000. */
  readonly rtosOffset: number;
  readonly rtosLength: number;
  /** Initialised RAM: its image in the RTOS image and length; copied to 0x55000000 at start-up. */
  readonly ramImage: number;
  readonly ramLength: number;
  /** ICONBIN section: data offset in the decoded payload and length. */
  readonly iconbinOffset: number;
  readonly iconbinLength: number;
  /** The colour work (slot edits, clarity table, monochrome looks, added slots): 1.11 only. */
  readonly colour: boolean;
  /** The 1.12 bridge firmware is made from this file: 1.11 only. */
  readonly bridge: boolean;
  readonly facts: TargetFacts;
  /** A 1.11 address (as the patcher is written) in this firmware. */
  va(address: number): number;
  /** An address of this firmware (RTOS image or initialised RAM) as a decoded-payload offset. */
  foff(address: number): number;
}

export const RTOS_VA = 0x53000000;
export const RAM_VA = 0x55000000;

function makeFoff(rtosOffset: number, rtosLength: number, ramImage: number, ramLength: number): (va: number) => number {
  return (va: number): number => {
    if (va >= RAM_VA && va < RAM_VA + ramLength) va = ramImage + (va - RAM_VA);
    if (!(va >= RTOS_VA && va < RTOS_VA + rtosLength)) throw new FirmwareError('bad-address', `0x${va.toString(16)} is outside the RTOS image`);
    return rtosOffset + va - RTOS_VA;
  };
}

export const TARGET_111: FirmwareTarget = {
  id: '1.11',
  versions: { STANDARD: '1.11', HDF: '1.11', MONO: '1.00' },
  officialSha256: 'a2f664dfca034059eb0fd6e18ab08684c326b4a034d85c164dad7e1ec9b5655f',
  officialSize: 38648776,
  decodedSha256: 'c4e597c7c9ca1bc181b30e35139ed90a4fd876ddcca14f12be0e00b6702233ae',
  decodedSize: 67948280,
  rtosOffset: 0x17d10,
  rtosLength: 0x13d2ac0,
  ramImage: 0x5437b640,
  ramLength: 0x57480,
  iconbinOffset: 0x2e93af0,
  iconbinLength: 0xdcf460,
  colour: true,
  bridge: true,
  facts: {
    iconCount: 663,
    textCount: 837,
    firstTextTable: 0x5437d7b0,
    textTableStride: 0xd14,
    textCapacity: 896,
    ratioTexts: [267, 268, 266, 269],
    texts: { softFocus: 840, dateStamp: { name: 841, onOff: 842, style: 843, short: 844, long: 845, orient: 879 }, shutdown: 853 },
    userDataSize: 0xae9,
    userData: 0x55084dd8,
    liveViewShift: 0,
    iconBoundForm: 'movw',
    bssEnd: 0x558372d4,
    heap: 0x55837300,
    camera: {
      texts: { on: 1, off: 2, low: 9, medium: 10, high: 11, flashComp: 135, endScreen: 701, dRange: 363, horizon: 388, reset: 703 },
      icons: { off: 310, on: 311 },
    },
    listRecords: 124,
    submenuRecords: 18,
    jpegCount: 12,
    tileIcons: { nega: 0x2fc2cf0, cinemaYellow: 0x30221f0 },
    looks: 31,
    monoLooks: [13, 14, 15, 16, 25, 26, 27, 28, 29, 30],
  },
  va: (address: number): number => address,
  foff: makeFoff(0x17d10, 0x13d2ac0, 0x5437b640, 0x57480),
};

export const TARGET_120: FirmwareTarget = {
  id: '1.20',
  versions: { STANDARD: '1.20', HDF: '1.20', MONO: '1.10' },
  officialSha256: '7563d7e462f0c53b6ab2fbab7cdfbbb57151a41192ee82f4f3a2108f9d77650d',
  officialSize: 38919904,
  decodedSha256: 'f5cf55a48f65d55f4ebbd40bcd1d64d1ceca3c88432a2a4ceaa93fe1cad5fc3a',
  decodedSize: 69632740,
  rtosOffset: 0x17d28,
  rtosLength: 0x140b600,
  ramImage: 0x543b3100,
  ramLength: 0x58500,
  iconbinOffset: 0x2eec088,
  iconbinLength: 0xf0f0e0,
  colour: false,
  bridge: false,
  facts: {
    iconCount: 709,
    textCount: 881,
    firstTextTable: 0x543b5270,
    textTableStride: 0xdc4,
    // 1.20 has texts up to 880, where 1.11 had room for this program's own; they are above 911.
    textCapacity: 960,
    ratioTexts: [281, 282, 280, 284],
    // 929: "Follow Orientation" (0.8.3), after the power-off pictures' 918..928
    texts: { softFocus: 912, dateStamp: { name: 913, onOff: 914, style: 915, short: 916, long: 917, orient: 929 }, shutdown: 918 },
    userDataSize: 0xb44,
    userData: 0x550832a8,
    liveViewShift: 0x14,
    iconBoundForm: 'cmp',
    bssEnd: 0x55839014,
    heap: 0x55839040,
    camera: {
      texts: { on: 1, off: 2, low: 10, medium: 11, high: 12, flashComp: 140, endScreen: 743, dRange: 395, horizon: 420, reset: 745 },
      icons: { off: 329, on: 330 },
    },
    listRecords: 126,
    submenuRecords: 18,
    jpegCount: 13,
    // the same pixels as in 1.11, found in 1.20's ICONBIN
    tileIcons: { nega: 0x301b288, cinemaYellow: 0x30efa88 },
    looks: 33,
    monoLooks: [13, 14, 15, 16, 25, 26, 27, 28, 29, 30, 31, 32],
  },
  va: (address: number): number => {
    const v = VA_120.get(address);
    if (v === undefined) throw new FirmwareError('unported', `0x${address.toString(16)} has no place in firmware 1.20`);
    return v;
  },
  foff: makeFoff(0x17d28, 0x140b600, 0x543b3100, 0x58500),
};

export const TARGETS: readonly FirmwareTarget[] = [TARGET_111, TARGET_120];

/** The target whose official file has this size and SHA-256, or null. */
export function targetOfOfficial(size: number, sha256: string): FirmwareTarget | null {
  return TARGETS.find((t) => t.officialSize === size && t.officialSha256 === sha256) ?? null;
}

/** The target of an official decoded payload's size, or null (a cheap first test; the hash decides). */
export function targetOfDecodedSize(size: number): FirmwareTarget | null {
  return TARGETS.find((t) => t.decodedSize === size) ?? null;
}

/**
 * The official release this program builds on for each model, as Ricoh numbers it for that model
 * (what the program downloads from Ricoh's site): 1.11 for the GR IV and GR IV HDF, which has every
 * addition; 1.10 (the 1.20 file) for the GR IV Monochrome, which has no colour work to lose and
 * refuses the 1.11 file (its Monochrome record, 1.00, is older) once it runs 1.10.
 */
export const SUPPORTED_RELEASE: Readonly<Record<TargetModel, string>> = {
  STANDARD: TARGET_111.versions.STANDARD,
  HDF: TARGET_111.versions.HDF,
  MONO: TARGET_120.versions.MONO,
};

/** The file a model's official release is, by the version Ricoh gives it for that model, or null. */
export function targetOfRelease(model: TargetModel, version: string): FirmwareTarget | null {
  return TARGETS.find((t) => t.versions[model] === version) ?? null;
}
