// SPDX-License-Identifier: GPL-2.0-only
/**
 * Exposure preview as a camera setting, and soft focus in the camera menu (firmware 1.20; test 080).
 *
 * Exposure preview (issue #17; test 078 had it always off): On (the camera's own live view), Off
 * with Direct Flash (only while Direct Flash is the Flash Mode; offered when Direct Flash is in the
 * build) and Always Off. "Off": the live view of stills keeps a normal brightness (in M as in P, the
 * exposure compensation not applied, see `lvpreview.ts`); the pictures are taken as set.
 *  - Kept in byte 0x10B of the user settings (CURRENT() + 4 + 0x10B): alignment padding between the
 *    byte at 0x108 and the word at 0x10C, which the factory-defaults initialiser (UserDataInitValue,
 *    0x53546C24, run in the emulator on all 30 default records) never writes, as 0x109 (Direct
 *    Flash's fastest shutter speed) and 0x10A (HDR). Saved, loaded and copied to U1..U3 with the
 *    settings, 0 (On) on every camera and after a reset. The settings guard makes anything above 2
 *    0; a value the build does not offer (1 without Direct Flash) counts as On.
 *  - A line of the still shooting menu, "Exposure Preview", last on the Exposure Settings page,
 *    opening a list (controller id 0x020001D2, Horizon Correction's list controller, as HDR's).
 *  - An ADJ lever function, 0x15: the camera has none free (0..0x14 are all used; 0x0A is soft
 *    focus), so AdjModeController's table (21 records of 0x5C at 0x53DC9DFC, read in 22 places
 *    through MOVW / MOVT and by its initialiser 0x531BD4BC up to the end word at 0x531BD600, which
 *    sizes the list from every record's count) is copied with a 22nd record, Crop's with handlers of
 *    its own and no "disabled" check (+0x3C). All 23 references move with it. (GR Mod 0.5.0/0.5.1
 *    also copied the table with a 22nd record, left one reference behind and the camera froze when
 *    ADJ was pressed: with the end word left, the initialiser walks from the copy towards the
 *    official end, which it never meets.) The function's name (0x5338F484) and icon (0x53390E40)
 *    get a case for 0x15 at their entries; the list of functions the ADJ Mode Setting offers gets
 *    0x15 after soft focus (or after Image Control); the five slot getters (with soft focus),
 *    ADJ slots 6..8 (`adjslots.ts`) and the settings guard take functions up to 0x15.
 *
 * Soft focus (until now only on the ADJ lever, `softfocus.ts`): a line of the still shooting menu,
 * "Soft Focus", after Image Control, opening a list Off / Low / Medium / High (controller id
 * 0x020001D1) of the same setting byte (0x90F).
 *
 * The still menu then has more than 38 lines, the most the camera's menus hold: `menuwide.ts`.
 */
import { FirmwareError } from '../../types';
import { assembleWords, branchWord, movImmediate, movWord } from './arm';
import { ICON_CATALOG, LANGUAGES, LOOKUP_BOUNDS, Patch, concat, expectWord, u16le, u32le, widenTextRows } from './build';
import { ICON_OFF, ICON_ON, LIST_CONTROLLER_ID, LIST_SET_ITEM, StillLine, TEXT_OFF, TEXT_ON, TOP_SET_TITLE, addListRecords, hookControllerFactory, installTexts, listTemplate } from './datestamp-menu';
import { DIRECT_FLASH_BYTE, DIRECT_FLASH_ICON_ID, LIVE_FLASH_MODE } from './directflash';
import { installExposurePreviewOff } from './lvpreview';
import { SOFT_FOCUS_BYTE, SOFT_FOCUS_TEXT_ID } from './softfocus';

/** The setting byte: 0 On, 1 Off with Direct Flash, 2 Always Off. */
export const EXPOSURE_PREVIEW_BYTE = 0x550832a8 + 4 + 0x10b;
/** The same byte as the settings guard sees it (the settings object, CURRENT()). */
export const EXPOSURE_PREVIEW_GUARD = 0x10f;
export const ADJ_EXPOSURE_PREVIEW = 0x15;
export const EP_TEXT_IDS = { name: 1019, offDirect: 1020, alwaysOff: 1021 } as const;
/** The ADJ function's icon, and the soft focus levels' (identities 18..21 of the ratio icon numbers, never given out). */
export const EP_ICON_ID = 734;
export const SOFT_LEVEL_ICON_IDS = [735, 736, 737] as const;
export const SOFT_FOCUS_LIST_ID = 0x020001d1;
export const EP_LIST_ID = 0x020001d2;
/** Image Control (the soft focus line follows it) and Link Exposure and Focus Point (the last of the Exposure Settings page). */
export const IMAGE_CONTROL_ID = 0x02000015;
export const LINK_AE_AF_ID = 0x02000081;

const TOP_SET_ICON = 0x5359d6f4; // (menu line, icon)
const LIST_ITEM = 0x53593d64; // (list, index) -> item (the ADJ controller's list view)
const ITEM_SET_TEXT = 0x535a1138; // (item, text number)
const SOFT_TEXTS = [TEXT_OFF, 10, 11, 12] as const; // Off, Low, Medium, High

const ADJ_TABLE = 0x53dc9dfc;
const ADJ_RECORD = 0x5c;
const ADJ_FUNCTIONS = 21;
const CROP = 0x13;
const H_DRAW = 0x18;
const H_IS_CURRENT = 0x20;
const H_SET = 0x28;
const H_COUNT = 0x30;
/** Every MOVW / MOVT pair that loads the table's address: [movw, movt, register]. */
const ADJ_TABLE_SITES: readonly (readonly [number, number, number])[] = [
  [0x531bd4c4, 0x531bd4d4, 4], [0x531bee8c, 0x531bee94, 2], [0x531bf028, 0x531bf030, 3], [0x531bf0c4, 0x531bf0cc, 2],
  [0x531bf5c0, 0x531bf5c8, 2], [0x531bffd4, 0x531bffdc, 2], [0x531c0030, 0x531c0038, 2], [0x531c0128, 0x531c0130, 2],
  [0x531c01b4, 0x531c01bc, 2], [0x531c0240, 0x531c0248, 2], [0x531c02e8, 0x531c02f0, 7], [0x531c0434, 0x531c043c, 2],
  [0x531c05d4, 0x531c05dc, 2], [0x531c06d0, 0x531c06e8, 4], [0x531c09dc, 0x531c09e4, 6], [0x531c0ae8, 0x531c0af0, 2],
  [0x531c0b94, 0x531c0b9c, 2], [0x531c0bfc, 0x531c0c0c, 7], [0x531c0cb8, 0x531c0cc8, 7], [0x531c0e9c, 0x531c0ea4, 2],
  [0x531c1060, 0x531c1064, 3], [0x531c1220, 0x531c1228, 2],
];
/** The initialiser's end of the table (a literal word). */
const ADJ_TABLE_END = 0x531bd600;
const NAME_OF = 0x5338f484; // (resources, function) -> text: cmp r1, #0 first
const ICON_OF = 0x53390e40; // (resources, function, variant) -> icon: cmp r1, #0 first
const FUNCTION_LIST_LOW = 0x531dc834; // movw r4, #lo(list)
const FUNCTION_LIST_HIGH = 0x531dc844; // movt r4, #hi(list)
const FUNCTION_LIST_LENGTH = 0x531dc860; // add r6, r4, #length
const ADJ_SOFT_FOCUS = 0x0a;
const ADJ_IMAGE_CONTROL = 0x0f;

/** In `LANGS` order (cs da en fi fr de el hu it ja ko nl pl pt ru zh-CN es sv th zh-TW tr). */
export const EP_NAMES: readonly string[] = [
  'Náhled expozice', 'Eksponeringsvisning', 'Exposure Preview', 'Valotuksen esikatselu', "Aperçu de l'exposition", 'Belichtungsvorschau',
  'Προεπισκόπηση έκθεσης', 'Expozíció előnézete', 'Anteprima esposizione', '露出プレビュー', '노출 미리보기', 'Belichtingsvoorbeeld',
  'Podgląd ekspozycji', 'Pré-visualizar exposição', 'Предпросмотр экспозиции', '曝光预览', 'Vista previa de exposición',
  'Förhandsvisa exponering', 'แสดงตัวอย่างการรับแสง', '曝光預覽', 'Pozlama önizleme',
];
export const EP_OFF_DIRECT_NAMES: readonly string[] = [
  'Vyp. při přímém blesku', 'Fra ved direkte blitz', 'Off in Direct Flash', 'Pois suoralla salamalla', 'Désactivé en flash direct',
  'Aus bei Direktblitz', 'Ανενεργό με άμεσο φλας', 'Ki közvetlen vakunál', 'Off con flash diretto', 'ダイレクト発光時オフ',
  '다이렉트 플래시 시 끄기', 'Uit bij directe flits', 'Wył. przy błysku bezpośr.', 'Desl. no flash direto', 'Выкл. при прямой вспышке',
  '直闪模式时关闭', 'Desact. con flash directo', 'Av vid direktblixt', 'ปิดเมื่อใช้แฟลชตรง', '直閃模式時關閉', 'Doğrudan flaşta kapalı',
];
export const EP_ALWAYS_OFF_NAMES: readonly string[] = [
  'Vždy vypnuto', 'Altid fra', 'Always Off', 'Aina pois', 'Toujours désactivé', 'Immer aus', 'Πάντα ανενεργό', 'Mindig ki',
  'Sempre off', '常にオフ', '항상 끄기', 'Altijd uit', 'Zawsze wył.', 'Sempre desligado', 'Всегда выкл.', '始终关闭',
  'Siempre desactivado', 'Alltid av', 'ปิดเสมอ', '始終關閉', 'Her zaman kapalı',
];

export interface ExposurePreviewOptions {
  /** Exposure preview (the setting, its line, the ADJ function, the live view). */
  exposurePreview: boolean;
  /** Direct Flash is in the build: the middle value is offered. */
  directFlash: boolean;
  /** Soft focus is on the ADJ lever: its line in the still menu too. */
  softFocus: boolean;
}

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}
const lo = (v: number): number => v & 0xffff;
const hi = (v: number): number => v >>> 16;

/** The values offered, in list order. */
export function exposurePreviewValues(directFlash: boolean): readonly number[] {
  return directFlash ? [0, 1, 2] : [0, 2];
}

function valueText(v: number, directFlash: boolean): number {
  return v === 0 ? TEXT_ON : v === 1 ? EP_TEXT_IDS.offDirect : directFlash ? EP_TEXT_IDS.alwaysOff : TEXT_OFF;
}
function valueIcon(v: number): number {
  return v === 0 ? ICON_ON : v === 1 ? DIRECT_FLASH_ICON_ID : ICON_OFF;
}

/** r3 = the setting (r2 = its address); a value the build does not offer becomes (and is stored as) 0. */
function loadPreview(directFlash: boolean): string {
  return `movw r2, #${lo(EXPOSURE_PREVIEW_BYTE)}; movt r2, #${hi(EXPOSURE_PREVIEW_BYTE)}; ldrb r3, [r2]
    cmp r3, #2; movhi r3, #0; strbhi r3, [r2]
    ${directFlash ? '' : 'cmp r3, #1; moveq r3, #0; strbeq r3, [r2]'}`;
}
/** r3 = the soft focus setting (r2 = its address); above 3 becomes (and is stored as) 0. */
const LOAD_SOFT = `movw r2, #${lo(SOFT_FOCUS_BYTE)}; movt r2, #${hi(SOFT_FOCUS_BYTE)}; ldrb r3, [r2]
    cmp r3, #3; movhi r3, #0; strbhi r3, [r2]`;

// --------------------------------------------------------------------------------------------
// Icons

function tile(px: Uint8Array): void {
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const i = (y * 40 + x) * 4;
      if (x < 1 || y < 1 || x > 38 || y > 38) px.set([255, 255, 255, 0], i);
      else if (x === 1 || y === 1 || x === 38 || y === 38) px.set([128, 128, 128, 255], i);
      else px.set([53, 53, 54, 255], i);
    }
  }
}

/** Blend white over the tile at (x, y) with coverage `a` (0..1). */
function white(px: Uint8Array, x: number, y: number, a: number, grey = 255): void {
  if (x < 2 || y < 2 || x > 37 || y > 37 || a <= 0) return;
  const i = (y * 40 + x) * 4;
  for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c] + (grey - px[i + c]) * Math.min(1, a));
}

/** 4x4 supersampled coverage of `inside` over each pixel. */
function paint(px: Uint8Array, inside: (x: number, y: number) => number, grey = 255): void {
  for (let y = 2; y < 38; y++) {
    for (let x = 2; x < 38; x++) {
      let sum = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) sum += inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
      white(px, x, y, sum / 16, grey);
    }
  }
}

/** The ADJ function's icon: an eye (the preview) on the camera's ADJ tile. */
export function drawExposurePreviewIcon(): Uint8Array {
  const px = new Uint8Array(40 * 40 * 4);
  tile(px);
  const cx = 20, cy = 20, rx = 14, ry = 8.5;
  // Almond outline: |y - cy| <= ry * (1 - ((x - cx) / rx)^2), 2 px thick.
  const half = (x: number): number => {
    const t = (x - cx) / rx;
    return Math.abs(t) >= 1 ? -1 : ry * (1 - t * t);
  };
  paint(px, (x, y) => {
    const h = half(x);
    const d = Math.abs(y - cy);
    return h >= 0 && d <= h && d >= h - 2 ? 1 : 0;
  });
  paint(px, (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    return r <= 5 && r >= 2 ? 1 : 0;
  });
  return px;
}

/** Soft focus Low / Medium / High (`level` 1..3): a soft point of light and level bars, on the tile. */
export function drawSoftLevelIcon(level: number): Uint8Array {
  const px = new Uint8Array(40 * 40 * 4);
  tile(px);
  const cx = 20, cy = 15, core = 3.5, halo = 10;
  paint(px, (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    if (r <= core) return 1;
    if (r >= halo) return 0;
    const t = 1 - (r - core) / (halo - core);
    return 0.85 * t * t * (3 - 2 * t);
  });
  for (let b = 0; b < 3; b++) {
    const x0 = 9 + b * 8, x1 = x0 + 6, y1 = 34, y0 = y1 - (4 + 3 * b);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const edge = x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1;
        if (b < level) white(px, x, y, 1);
        else if (edge) white(px, x, y, 1, 128);
      }
    }
  }
  return px;
}

// --------------------------------------------------------------------------------------------

/** Texts and icons (call once, before the menus use them). Returns ICONBIN with the icons appended. */
export function installExposurePreviewAssets(patch: Patch, iconbin: Uint8Array, o: ExposurePreviewOptions): Uint8Array {
  if (o.exposurePreview) {
    widenTextRows(patch, EP_TEXT_IDS.alwaysOff);
    installTexts(patch, [
      { id: EP_TEXT_IDS.name, names: EP_NAMES },
      { id: EP_TEXT_IDS.offDirect, names: EP_OFF_DIRECT_NAMES },
      { id: EP_TEXT_IDS.alwaysOff, names: EP_ALWAYS_OFF_NAMES },
    ]);
  }
  if (EP_NAMES.length !== LANGUAGES || EP_OFF_DIRECT_NAMES.length !== LANGUAGES || EP_ALWAYS_OFF_NAMES.length !== LANGUAGES) fail('internal', 'exposure preview: texts');
  const icons: { id: number; px: Uint8Array }[] = o.exposurePreview ? [{ id: EP_ICON_ID, px: drawExposurePreviewIcon() }] : [];
  if (o.softFocus) SOFT_LEVEL_ICON_IDS.forEach((id, k) => icons.push({ id, px: drawSoftLevelIcon(k + 1) }));
  const parts: Uint8Array[] = [iconbin];
  let length = iconbin.length;
  for (const { id, px } of icons) {
    if (patch.word(ICON_CATALOG + id * 4) !== 0) fail('unexpected-layout', 'icon number already in use');
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      length += pad;
    }
    const offset = length;
    parts.push(px);
    length += px.length;
    const descriptor = patch.append(concat([u16le([1, 40, 40, 0]), u32le([offset / 4])]), 16);
    patch.write(ICON_CATALOG + id * 4, u32le([descriptor]));
  }
  if (icons.length === 0) return iconbin;
  const upper = Math.max(...icons.map((x) => x.id));
  for (const [site, register] of LOOKUP_BOUNDS) {
    if ((patch.word(site) & 0xfff0f000) >>> 0 !== (0xe3000000 | (register << 12)) >>> 0) fail('unexpected-layout', 'icon bound is not a MOVW');
    patch.setWord(site, movWord(register, Math.max(upper, movImmediate(patch.word(site)))), 'icon upper bound');
  }
  return concat(parts);
}

/** The still-menu lines (draw functions; before the still menu is built). */
export function exposurePreviewStillLines(patch: Patch, o: ExposurePreviewOptions): StillLine[] {
  expectWord(patch, TOP_SET_ICON, 0xe1a0c00d);
  expectWord(patch, TOP_SET_TITLE, 0xe1a0c00d);
  const lines: StillLine[] = [];
  if (o.softFocus) {
    const draw = patch.append((at) => assembleWords(
      `push {r4, lr}
       mov r4, r1
       ${LOAD_SOFT}
       cmp r3, #0; movweq r1, #${ICON_OFF}
       cmp r3, #1; movweq r1, #${SOFT_LEVEL_ICON_IDS[0]}
       cmp r3, #2; movweq r1, #${SOFT_LEVEL_ICON_IDS[1]}
       cmp r3, #3; movweq r1, #${SOFT_LEVEL_ICON_IDS[2]}
       mov r0, r4; bl #${TOP_SET_ICON}
       mov r0, r4; movw r1, #${SOFT_FOCUS_TEXT_ID}
       pop {r4, lr}; b #${TOP_SET_TITLE}`, at), 16);
    lines.push({ draw, id: SOFT_FOCUS_LIST_ID, after: IMAGE_CONTROL_ID });
  }
  if (!o.exposurePreview) return lines;
  const draw = patch.append((at) => assembleWords(
    `push {r4, lr}
     mov r4, r1
     ${loadPreview(o.directFlash)}
     ${exposurePreviewValues(o.directFlash).map((v) => `cmp r3, #${v}; movweq r1, #${valueIcon(v)}`).join('\n')}
     mov r0, r4; bl #${TOP_SET_ICON}
     mov r0, r4; movw r1, #${EP_TEXT_IDS.name}
     pop {r4, lr}; b #${TOP_SET_TITLE}`, at), 16);
  lines.push({ draw, id: EP_LIST_ID, after: LINK_AE_AF_ID });
  return lines;
}

/** The lists the lines open (after the additions that copy the list table first). */
export function installExposurePreviewLists(patch: Patch, o: ExposurePreviewOptions): void {
  expectWord(patch, LIST_SET_ITEM, 0xe1a0c00d);
  const record = (title: number, count: number, draw: number, set: number, current: number): Uint8Array => {
    const r = listTemplate(patch);
    const v = new DataView(r.buffer);
    v.setUint16(4, title, true);
    v.setUint32(0x0c, count, true);
    v.setUint32(0x14, draw, true);
    v.setUint32(0x24, set, true);
    v.setUint32(0x2c, current, true);
    for (const off of [0x10, 0x18, 0x28, 0x30]) v.setUint32(off, 0, true);
    return r;
  };
  const entries: { id: number; record: Uint8Array }[] = [];
  // Lists: count (this = r0), draw (item = r1, value i = r2), set and is current (value i = r1).
  if (o.softFocus) {
    const count = patch.append((at) => assembleWords('mov r0, #4; bx lr', at), 16);
    const icons = [ICON_OFF, ...SOFT_LEVEL_ICON_IDS];
    const draw = patch.append((at) => assembleWords(
      `cmp r2, #3; bxhi lr
       mov r0, r1; mov ip, r2
       ${[0, 1, 2, 3].map((i) => `cmp ip, #${i}; movweq r1, #${icons[i]}; movweq r2, #${SOFT_TEXTS[i]}`).join('\n')}
       b #${LIST_SET_ITEM}`, at), 16);
    const set = patch.append((at) => assembleWords(
      `cmp r1, #3; bxhi lr
       movw r2, #${lo(SOFT_FOCUS_BYTE)}; movt r2, #${hi(SOFT_FOCUS_BYTE)}; strb r1, [r2]; bx lr`, at), 16);
    const current = patch.append((at) => assembleWords(
      `${LOAD_SOFT}
       cmp r3, r1; moveq r0, #1; movne r0, #0; bx lr`, at), 16);
    entries.push({ id: SOFT_FOCUS_LIST_ID, record: record(SOFT_FOCUS_TEXT_ID, count, draw, set, current) });
  }
  if (o.exposurePreview) addExposurePreviewList(patch, o, entries, record);
  if (entries.length === 0) return;
  addListRecords(patch, entries, 'exposure preview and soft focus');
  const ids = entries.map((x) => x.id);
  hookControllerFactory(patch, `${ids.map((id) => `movw ip, #${lo(id)}; movt ip, #${hi(id)}
     cmp r1, ip; beq list`).join('\n')}
     b prior
     list: movw r1, #${lo(LIST_CONTROLLER_ID)}; movt r1, #${hi(LIST_CONTROLLER_ID)}`, 'exposure preview and soft focus: the list controller');
}

function addExposurePreviewList(patch: Patch, o: ExposurePreviewOptions, entries: { id: number; record: Uint8Array }[], record: (title: number, count: number, draw: number, set: number, current: number) => Uint8Array): void {
  const values = exposurePreviewValues(o.directFlash);
  const count = patch.append((at) => assembleWords(`mov r0, #${values.length}; bx lr`, at), 16);
  const draw = patch.append((at) => assembleWords(
    `cmp r2, #${values.length - 1}; bxhi lr
     mov r0, r1; mov ip, r2
     ${values.map((v, i) => `cmp ip, #${i}; movweq r1, #${valueIcon(v)}; movweq r2, #${valueText(v, o.directFlash)}`).join('\n')}
     b #${LIST_SET_ITEM}`, at), 16);
  // List index i -> value values[i].
  const set = patch.append((at) => assembleWords(
    `cmp r1, #${values.length - 1}; bxhi lr
     ${values.map((v, i) => `cmp r1, #${i}; moveq r3, #${v}`).join('\n')}
     movw r2, #${lo(EXPOSURE_PREVIEW_BYTE)}; movt r2, #${hi(EXPOSURE_PREVIEW_BYTE)}; strb r3, [r2]; bx lr`, at), 16);
  const current = patch.append((at) => assembleWords(
    `${loadPreview(o.directFlash)}
     mvn ip, #0
     ${values.map((v, i) => `cmp r3, #${v}; moveq ip, #${i}`).join('\n')}
     cmp ip, r1; moveq r0, #1; movne r0, #0; bx lr`, at), 16);
  entries.push({ id: EP_LIST_ID, record: record(EP_TEXT_IDS.name, count, draw, set, current) });
}

/** The live view (`lvpreview.ts`) by the setting. */
export function installExposurePreviewLive(patch: Patch, o: ExposurePreviewOptions): void {
  installExposurePreviewOff(patch, { byte: EXPOSURE_PREVIEW_BYTE, directFlash: o.directFlash ? { byte: DIRECT_FLASH_BYTE, flashMode: LIVE_FLASH_MODE } : null });
}

/**
 * ADJ lever function 0x15 (after every addition that changes the table's records in place: soft
 * focus, Direct Flash). Returns the table's new address.
 */
export function installExposurePreviewAdj(patch: Patch, o: ExposurePreviewOptions): number {
  for (const [low, high, r] of ADJ_TABLE_SITES) {
    expectWord(patch, low, movWord(r, lo(ADJ_TABLE)));
    expectWord(patch, high, movWord(r, hi(ADJ_TABLE), true));
  }
  expectWord(patch, ADJ_TABLE_END, ADJ_TABLE + ADJ_FUNCTIONS * ADJ_RECORD);
  expectWord(patch, NAME_OF, 0xe3510000); // cmp r1, #0
  expectWord(patch, NAME_OF + 4, 0x1a000001); // bne 0x5338F494
  expectWord(patch, ICON_OF, 0xe3510000); // cmp r1, #0
  expectWord(patch, ICON_OF + 4, 0x1a000003); // bne 0x53390E58
  const crop = patch.read(ADJ_TABLE + CROP * ADJ_RECORD, ADJ_RECORD);
  const cv = new DataView(crop.buffer);
  if (cv.getUint32(0x10, true) !== 0x531bb654 || cv.getUint32(0x38, true) !== 0 || cv.getUint32(0x3c, true) !== 0x531bdf1c || cv.getUint32(0x40, true) !== 0) fail('unexpected-layout', 'Crop record of the ADJ table is not as expected');
  for (const off of [H_DRAW, H_IS_CURRENT, H_SET, H_COUNT]) if (cv.getUint32(off, true) === 0 || cv.getUint32(off + 4, true) !== 0) fail('unexpected-layout', 'Crop record of the ADJ table is not as expected');

  const values = exposurePreviewValues(o.directFlash);
  // --- Handlers (this = r0, value index = r1), as soft focus's.
  const draw = patch.append((at) => assembleWords(
    `push {r4, r5, r6, lr}
     mov r5, r0; mov r4, r1; mov r6, #0
     ${values.map((v, i) => `cmp r4, #${i}; movweq r6, #${valueText(v, o.directFlash)}`).join('\n')}
     ldr r0, [r5, #0x1f8]; uxtb r1, r4; bl #${LIST_ITEM}
     mov r1, r6; pop {r4, r5, r6, lr}; b #${ITEM_SET_TEXT}`, at), 16);
  const current = patch.append((at) => assembleWords(
    `${loadPreview(o.directFlash)}
     mvn ip, #0
     ${values.map((v, i) => `cmp r3, #${v}; moveq ip, #${i}`).join('\n')}
     cmp ip, r1; moveq r0, #1; movne r0, #0; bx lr`, at), 16);
  const set = patch.append((at) => assembleWords(
    `cmp r1, #${values.length - 1}; bxhi lr
     ${values.map((v, i) => `cmp r1, #${i}; moveq r3, #${v}`).join('\n')}
     movw r2, #${lo(EXPOSURE_PREVIEW_BYTE)}; movt r2, #${hi(EXPOSURE_PREVIEW_BYTE)}; strb r3, [r2]; bx lr`, at), 16);
  const count = patch.append((at) => assembleWords(`mov r0, #${values.length}; bx lr`, at), 16);
  const record = crop.slice();
  const rv = new DataView(record.buffer);
  rv.setUint32(H_DRAW, draw, true);
  rv.setUint32(H_IS_CURRENT, current, true);
  rv.setUint32(H_SET, set, true);
  rv.setUint32(H_COUNT, count, true);
  rv.setUint32(0x3c, 0, true); // no "disabled" check (Crop's would disable it with Crop)

  // --- The table, copied with the record; every reference moved.
  const table = patch.append(concat([patch.read(ADJ_TABLE, ADJ_FUNCTIONS * ADJ_RECORD), record]), 16);
  for (const [low, high, r] of ADJ_TABLE_SITES) {
    patch.setWord(low, movWord(r, lo(table)), 'exposure preview: ADJ function table, low half');
    patch.setWord(high, movWord(r, hi(table), true), 'exposure preview: ADJ function table, high half');
  }
  patch.setWord(ADJ_TABLE_END, table + (ADJ_FUNCTIONS + 1) * ADJ_RECORD, 'exposure preview: end of the ADJ function table');

  // --- Name and icon.
  const name = patch.append((at) => assembleWords(
    `cmp r1, #${ADJ_EXPOSURE_PREVIEW}; movweq r0, #${EP_TEXT_IDS.name}; bxeq lr
     cmp r1, #0; b #${NAME_OF + 4}`, at), 16);
  patch.setWord(NAME_OF, branchWord(NAME_OF, name), 'exposure preview: ADJ function name');
  const icon = patch.append((at) => assembleWords(
    `cmp r1, #${ADJ_EXPOSURE_PREVIEW}; bne other
     cmp r2, #0; movne r0, #0; movweq r0, #${EP_ICON_ID}; bx lr
     other: cmp r1, #0; b #${ICON_OF + 4}`, at), 16);
  patch.setWord(ICON_OF, branchWord(ICON_OF, icon), 'exposure preview: ADJ function icon');

  // --- ADJ Mode Setting: the functions offered.
  const listAt = (movImmediate(patch.word(FUNCTION_LIST_LOW)) | (movImmediate(patch.word(FUNCTION_LIST_HIGH)) << 16)) >>> 0;
  expectWord(patch, FUNCTION_LIST_LOW, movWord(4, lo(listAt)));
  expectWord(patch, FUNCTION_LIST_HIGH, movWord(4, hi(listAt), true));
  const lengthWord = patch.word(FUNCTION_LIST_LENGTH);
  if ((lengthWord & 0xffffff00) >>> 0 !== 0xe2846000) fail('unexpected-layout', 'ADJ function list length is not as expected');
  const old = [...patch.read(listAt, lengthWord & 0xff)];
  if (old.includes(ADJ_EXPOSURE_PREVIEW) || old.some((f) => f > 0x14)) fail('unexpected-layout', 'ADJ function list is not as expected');
  const after = old.includes(ADJ_SOFT_FOCUS) ? ADJ_SOFT_FOCUS : ADJ_IMAGE_CONTROL;
  if (!old.includes(after)) fail('unexpected-layout', 'ADJ function list has no Image Control');
  const list = [...old];
  list.splice(old.indexOf(after) + 1, 0, ADJ_EXPOSURE_PREVIEW);
  const newList = patch.append(Uint8Array.from(list), 16);
  patch.setWord(FUNCTION_LIST_LOW, movWord(4, lo(newList)), 'exposure preview: ADJ function list, low half');
  patch.setWord(FUNCTION_LIST_HIGH, movWord(4, hi(newList), true), 'exposure preview: ADJ function list, high half');
  patch.setWord(FUNCTION_LIST_LENGTH, 0xe2846000 | list.length, 'exposure preview: ADJ function list length');
  return table;
}
