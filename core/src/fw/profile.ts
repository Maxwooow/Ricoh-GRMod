/**
 * Everything that is specific to GR IV firmware 1.11 (fwdc248b.bin): hashes, section offsets,
 * table addresses and the expected resolved addresses of the two editable Image Control slots.
 *
 * Addresses ("VA") are the run-time addresses used by the RTOS image; `foff()` maps them to
 * offsets in the decoded payload exactly like `plan.py`.
 */
import { Firmware, FirmwareError, sha256Hex } from './container';

export const FIRMWARE_VERSION = '1.11';
export const OFFICIAL_SHA256 = 'a2f664dfca034059eb0fd6e18ab08684c326b4a034d85c164dad7e1ec9b5655f';
export const DECODED_SHA256 = 'c4e597c7c9ca1bc181b30e35139ed90a4fd876ddcca14f12be0e00b6702233ae';
export const OFFICIAL_SIZE = 38648776;
export const DECODED_SIZE = 67948280;

/** RTOS section: data offset in the decoded payload, length, load address. */
export const RTOS_OFFSET = 0x17d10;
export const RTOS_LENGTH = 0x13d2ac0;
export const RTOS_VA = 0x53000000;
/** Initialised RAM: lives at RAM_VA at run time, stored in the RTOS image at RAM_IMAGE_VA. */
export const RAM_VA = 0x55000000;
export const RAM_IMAGE_VA = 0x5437b640;
export const RAM_LENGTH = 0x57480;

/** ICONBIN section: data offset in the decoded payload and length. */
export const ICONBIN_OFFSET = 0x2e93af0;
export const ICONBIN_LENGTH = 0xdcf460;

/** Per-style pointer tables (34 entries x 3 identical variants), all in the RAM image. */
export const T_REC = 0x55053780; // tone record table
export const T_MA = 0x55053504; // multi-axis table
export const T_GAM = 0x55053138; // gamma descriptor table
export const TABLE_ENTRIES = 34;
export const TABLE_VARIANTS = 3;

export const TONE_STANDARD = 0x0b;
export const TONE_CINEMA_YELLOW = 0x12;
export const TONE_CINEMA_GREEN = 0x13;

export const LEN = { matrix: 18, desc: 20, R: 512, G: 512, B: 512, ma_block: 0x870 } as const;

/** Checksum compensation word: 4 bytes inside the assert-only text "MakeParameter". */
export const COMP_VA = 0x54049394;
export const COMP_OFFSET = 0x10610a4;
const COMP_GUARD = 'MakeParameter\0';

/** 40x40 RGBA icon used only as a drawing template ("Nega": film frame with sprocket holes). */
export const NEGA_ICON_OFFSET = 0x2fc2cf0;
export const ICON_BYTES = 40 * 40 * 4;

export type SlotId = 'CY' | 'CG';

export interface SlotDef {
  id: SlotId;
  toneId: number;
  /** Index of the slot's name in each language's string table. */
  nameIndex: number;
  /** Decoded offset of the slot's 40x40 RGBA icon. */
  iconOffset: number;
  defaultName: string;
}

export const SLOTS: readonly SlotDef[] = [
  { id: 'CY', toneId: 0x12, nameIndex: 301, iconOffset: 0x30221f0, defaultName: 'Cinema (Yellow)' },
  { id: 'CG', toneId: 0x13, nameIndex: 302, iconOffset: 0x3023af0, defaultName: 'Cinema (Green)' },
];

export function slotDef(id: SlotId): SlotDef {
  const s = SLOTS.find((x) => x.id === id);
  if (!s) throw new FirmwareError('bad-edit', `unknown slot ${String(id)}`);
  return s;
}

/** VA -> decoded-payload offset (exactly `plan.py` `foff`). */
export function foff(va: number): number {
  if (va >= RAM_VA && va < RAM_VA + RAM_LENGTH) va = RAM_IMAGE_VA + (va - RAM_VA);
  if (!(va >= RTOS_VA && va < RTOS_VA + RTOS_LENGTH)) {
    throw new FirmwareError('bad-address', `0x${va.toString(16)} is outside the RTOS image`);
  }
  return RTOS_OFFSET + va - RTOS_VA;
}

function u32(d: Uint8Array, va: number): number {
  const o = foff(va);
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

export interface SlotInfo {
  tone: number;
  rec: number;
  matrix: number;
  desc: number;
  R: number;
  G: number;
  B: number;
  maRec: number;
  maBlock: number;
}

/** Port of `plan.py` `slot_info(tone)`: resolve a style's data addresses from the pointer tables. */
export function slotInfo(decoded: Uint8Array, tone: number): SlotInfo {
  const rec = u32(decoded, T_REC + 4 * tone);
  const desc = u32(decoded, T_GAM + 4 * tone);
  const ma = u32(decoded, T_MA + 4 * tone);
  const arrVa = u32(decoded, ma + 8);
  const first = u32(decoded, arrVa);
  for (let i = 1; i < 8; i++) {
    if (u32(decoded, arrVa + 4 * i) !== first) throw new FirmwareError('unexpected-layout', 'multi-axis block pointers differ');
  }
  for (let v = 1; v < TABLE_VARIANTS; v++) {
    const t = v * TABLE_ENTRIES + tone;
    if (u32(decoded, T_REC + 4 * t) !== rec || u32(decoded, T_GAM + 4 * t) !== desc || u32(decoded, T_MA + 4 * t) !== ma) {
      throw new FirmwareError('unexpected-layout', 'table variants differ');
    }
  }
  return {
    tone,
    rec,
    matrix: u32(decoded, rec + 4),
    desc,
    R: u32(decoded, desc + 8),
    G: u32(decoded, desc + 12),
    B: u32(decoded, desc + 16),
    maRec: ma,
    maBlock: first,
  };
}

/** Resolved addresses that must come out of `slotInfo` for firmware 1.11. */
export const EXPECTED_SLOT_INFO: Readonly<Record<SlotId, Readonly<Pick<SlotInfo, 'matrix' | 'desc' | 'R' | 'G' | 'B' | 'maBlock'>>>> = {
  CY: { matrix: 0x54049ce0, desc: 0x5407b1e0, R: 0x540808b4, G: 0x5407f0b4, B: 0x5407feb4, maBlock: 0x54049e00 },
  CG: { matrix: 0x5404952c, desc: 0x5407decc, R: 0x5407f6b4, G: 0x5407eeb4, B: 0x5407d6b8, maBlock: 0x5404a6d4 },
};
export const EXPECTED_STANDARD_MA_BLOCK = 0x5404af70;

export interface Layout {
  CY: SlotInfo;
  CG: SlotInfo;
  standard: SlotInfo;
}

/**
 * Resolve the slot addresses from the OFFICIAL decoded payload and assert every fact the builder
 * relies on. Throws `FirmwareError('unexpected-layout')` if anything differs.
 */
export function resolveLayout(decoded: Uint8Array): Layout {
  const fail = (what: string): never => {
    throw new FirmwareError('unexpected-layout', what);
  };
  if (decoded.length !== DECODED_SIZE) fail('decoded payload has the wrong size');
  const standard = slotInfo(decoded, TONE_STANDARD);
  if (standard.maBlock !== EXPECTED_STANDARD_MA_BLOCK) fail('Standard multi-axis block moved');
  const resolved = {} as Record<SlotId, SlotInfo>;
  for (const s of SLOTS) {
    const info = slotInfo(decoded, s.toneId);
    const exp = EXPECTED_SLOT_INFO[s.id];
    for (const k of ['matrix', 'desc', 'R', 'G', 'B', 'maBlock'] as const) {
      if (info[k] !== exp[k]) fail(`${s.id} ${k} resolved to 0x${info[k].toString(16)}, expected 0x${exp[k].toString(16)}`);
    }
    resolved[s.id] = info;
  }
  if (foff(COMP_VA) !== COMP_OFFSET || COMP_OFFSET % 4 !== 0) fail('compensation word offset');
  const g = foff(COMP_VA - 4);
  for (let i = 0; i < COMP_GUARD.length; i++) {
    if (decoded[g + i] !== COMP_GUARD.charCodeAt(i)) fail('compensation word is not inside "MakeParameter"');
  }
  return { CY: resolved.CY, CG: resolved.CG, standard };
}

/**
 * Accept only the official 1.11 file. Throws `FirmwareError('unsupported-firmware')` unless the
 * file's SHA-256 is `OFFICIAL_SHA256`; then parses it and also asserts the decoded SHA-256.
 */
export async function openOfficial(raw: Uint8Array): Promise<{ fw: Firmware; decoded: Uint8Array }> {
  if (raw.length !== OFFICIAL_SIZE || (await sha256Hex(raw)) !== OFFICIAL_SHA256) {
    throw new FirmwareError('unsupported-firmware', 'this is not the official GR IV firmware 1.11 file (fwdc248b.bin)');
  }
  const fw = new Firmware(raw);
  if (fw.decoded.length !== DECODED_SIZE || (await sha256Hex(fw.decoded)) !== DECODED_SHA256) {
    throw new FirmwareError('unsupported-firmware', 'decoded payload does not match firmware 1.11');
  }
  return { fw, decoded: fw.decoded };
}
