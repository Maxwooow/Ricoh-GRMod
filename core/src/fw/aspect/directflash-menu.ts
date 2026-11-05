// SPDX-License-Identifier: GPL-2.0-only
/**
 * Direct Flash's settings in the camera menu (0.8.4). The Flash submenu of the still shooting menu
 * (SubMenuController record 5, "Flash Mode": Flash Mode, Flash Output) gets a third line, "Direct
 * Flash Settings", that opens a submenu of its own (as the camera's Wireless submenu opens Pairing)
 * with four lines, each showing the icon of its current value and opening a list
 * (SelectMenuController):
 *
 *   Guide Number            GN 2 .. GN 36           the flash's guide number (ISO 100, metres)
 *   Background Brightness   -0.3 EV .. -5.0 EV      how much darker than a correct exposure the
 *                                                   background (ambient light only) is
 *   Minimum Shutter Speed   1/125 .. 1"             the slowest shutter speed (the camera's text)
 *   Exposure Priority       Standard / Max Sync     Standard: the background as chosen; where the
 *                                                   flash-sync limit holds the shutter back, a
 *                                                   smaller aperture and a higher ISO for a faster
 *                                                   sync limit. Max Sync (test 060): the shutter at
 *                                                   the sync limit wherever the subject can still
 *                                                   be correctly exposed (the planner)
 *
 * Where they are kept (see `tools/directflash/directflash.c`, which reads them):
 *  - byte 0x99A of the user settings (padding the factory-defaults initialiser never writes, next
 *    to Direct Flash's byte 0x99B): bits 0..5 the guide number itself (0, what the byte is on every
 *    camera, is GN 3, the GF-2's), bits 6..7 the exposure priority (2 Max Sync, else Standard);
 *  - bits 1..4 and 5..7 of byte 0x99B (bit 0: Direct Flash chosen, see `directflash.ts`): the
 *    background and the slowest shutter speed; 0 is -1.0 EV and 1/30 s;
 *  - test 062: bits 0..2 of byte 0x109 (padding, see `DIRECT_FLASH_TV_BYTE`): the fastest shutter
 *    speed (Maximum Shutter Speed, the fifth line); 0 is the camera's flash-sync limit.
 * A value the lists do not have (a byte an earlier build left) shows as the default; the planner
 * reads it the same way (an unlisted guide number 1..63 is used as it is).
 *
 * What is changed, all found by reading the official 1.11 code:
 *  - submenu record 5 (in the table wherever it is now, see `datestamp-menu.ts`): a third line,
 *    controller id DF_MENU_ID, value icon place 540 and no value icon, as the Wireless submenu's
 *    (record 13) line that opens Pairing (record 12);
 *  - a submenu record for DF_MENU_ID (`addSubmenuRecord`), laid out as the camera's four-line
 *    Smartphone Link submenu (record 14), with a fifth line (as the camera's five-line record 10);
 *  - five list records (Horizon Correction's, `addListRecords`), SetCurrentMenu mapping their ids;
 *  - the controller factory: the submenu controller for DF_MENU_ID, the list controller for the
 *    five list ids (as for the date imprint's);
 *  - texts DF_TEXT_ID.. (the submenu's name, four line names, the priority and sync-limit values in 21
 *    languages; the other values the same in every language) and 40x40 icons DF_ICON_ID.. (one
 *    per value).
 * Every list has at most 21 values: the list controller makes its rows for the longest list among
 * the camera's own records (21).
 */
import { FirmwareError } from '../types';
import { assembleWords, branchWord, movImmediate, movWord } from './arm';
import { ICON_CATALOG, LOOKUP_BOUNDS, LANGUAGES, Patch, TEXT_CATALOG, concat, expectWord, u16le, u32le, utf16z, widenTextRows } from './build';
import {
  LIST_CONTROLLER_ID, LIST_SET_ITEM, SUBMENU_CONTROLLER_ID, SUB_RECORD, SUB_SET_ICON, addListRecords, addSubmenuRecord, hookControllerFactory, listTemplate, submenuTable,
} from './datestamp-menu';
import { DIRECT_FLASH_BYTE, DIRECT_FLASH_GN_BYTE, DIRECT_FLASH_TV_BYTE } from './directflash';

/** Controller ids (not used by the firmware): the lists, the submenu. */
export const DF_GN_ID = 0x020001b0;
export const DF_BACKGROUND_ID = 0x020001b1;
export const DF_SLOWEST_ID = 0x020001b2;
export const DF_MENU_ID = 0x020001b3;
export const DF_PRIORITY_ID = 0x020001b4;
/** Test 062: the fastest shutter speed (the last list). */
export const DF_FASTEST_ID = 0x020001b5;
/** Texts: the submenu's name, the line names (GN, background, priority), then the values' names. */
export const DF_TEXT_ID = 910;
/** Test 062: the name of the fastest-shutter line, after every value's text (914 + 21 + 15 + 8 + 2 + 5). */
export const DF_FASTEST_TEXT_ID = DF_TEXT_ID + 4 + 21 + 15 + 8 + 2 + 5;
/** The camera's own "Minimum Shutter Speed" (ISO submenu), the name of the shutter line. */
export const TEXT_MIN_SHUTTER = 125;
/** Icons: one per value, guide numbers, backgrounds, shutter speeds, priorities. */
export const DF_ICON_ID = 663;

/** Guide numbers of the list (ISO 100, metres); stored as the number, the default (3) as 0. */
export const DF_GUIDE_NUMBERS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 25, 28, 32, 36];
export const DF_GN_DEFAULT = 3;
export const DF_GN_MASK = 0x3f;
/** Bits 6..7 of byte 0x99A: the exposure priority, 2 Max Sync, anything else Standard (test 060). */
export const DF_PRIORITY_SHIFT = 6;
/** Backgrounds: k / 3 EV darker, k = 1..15 (-0.3 .. -5.0 EV, test 061); stored as k, the default (-1.0 EV, k = 3) as 0. */
export const DF_BACKGROUND_THIRDS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
export const DF_BACKGROUND_DEFAULT = 3;
/** Slowest shutter speeds: name, stored code (bits 5..7 of 0x99B), Tv. */
export const DF_SLOWEST: readonly { name: string; code: number; tv: number }[] = [
  { name: '1/125', code: 7, tv: 7 }, { name: '1/60', code: 6, tv: 6 }, { name: '1/30', code: 0, tv: 5 }, { name: '1/15', code: 1, tv: 4 },
  { name: '1/8', code: 2, tv: 3 }, { name: '1/4', code: 3, tv: 2 }, { name: '1/2', code: 4, tv: 1 }, { name: '1"', code: 5, tv: 0 },
];
export const DF_BACKGROUND_SHIFT = 1;
export const DF_SLOWEST_SHIFT = 5;

/** In `LANGS` order (cs da en fi fr de el hu it ja ko nl pl pt ru zh-CN es sv th zh-TW tr). */
export const DF_MENU_NAMES: readonly string[] = [
  'Nastavení přímého blesku', 'Direkte blitz-indstillinger', 'Direct Flash Settings', 'Suoran salaman asetukset', 'Réglages flash direct',
  'Direktblitz-Optionen', 'Ρυθμίσεις άμεσου φλας', 'Közvetlen vaku beáll.', 'Impostazioni flash diretto', 'ダイレクト発光設定', '다이렉트 플래시 설정',
  'Instell. directe flits', 'Ustawienia błysku bezp.', 'Config. flash direto', 'Настр. прямой вспышки', '直闪设置', 'Ajustes flash directo',
  'Direktblixtinställningar', 'ตั้งค่าแฟลชตรง', '直閃設定', 'Doğrudan flaş ayarları',
];
export const DF_GN_NAMES: readonly string[] = [
  'Směrné číslo', 'Ledetal', 'Guide Number', 'Ohjeluku', 'Nombre guide', 'Leitzahl', 'Αριθμός οδηγός',
  'Kulcsszám', 'Numero guida', 'ガイドナンバー', '가이드 번호', 'Richtgetal', 'Liczba przewodnia', 'Número guia',
  'Ведущее число', '闪光指数', 'Número guía', 'Ledtal', 'ไกด์นัมเบอร์', '閃光指數', 'Kılavuz sayısı',
];
export const DF_BACKGROUND_NAMES: readonly string[] = [
  'Jas pozadí', 'Baggrundens lysstyrke', 'Background Brightness', 'Taustan kirkkaus', 'Luminosité arrière-plan', 'Hintergrundhelligkeit', 'Φωτεινότητα φόντου',
  'Háttér fényereje', 'Luminosità sfondo', '背景の明るさ', '배경 밝기', 'Helderheid achtergrond', 'Jasność tła', 'Brilho do fundo',
  'Яркость фона', '背景亮度', 'Brillo del fondo', 'Bakgrundens ljusstyrka', 'ความสว่างพื้นหลัง', '背景亮度', 'Arka plan parlaklığı',
];
export const DF_PRIORITY_NAMES: readonly string[] = [
  'Priorita expozice', 'Eksponeringsprioritet', 'Exposure Priority', 'Valotuksen etusija', 'Priorité exposition', 'Belichtungspriorität', 'Προτεραιότητα έκθεσης',
  'Expozíciós prioritás', 'Priorità esposizione', '露出優先', '노출 우선', 'Belichtingsprioriteit', 'Priorytet ekspozycji', 'Prioridade exposição',
  'Приоритет экспозиции', '曝光优先级', 'Prioridad exposición', 'Exponeringsprioritet', 'ลำดับการรับแสง', '曝光優先級', 'Pozlama önceliği',
];
/** The two priorities, in `LANGS` order. */
export const DF_LOW_ISO_NAMES: readonly string[] = [
  'Nízké ISO', 'Lav ISO', 'Low ISO', 'Matala ISO', 'ISO bas', 'Niedrige ISO', 'Χαμηλό ISO',
  'Alacsony ISO', 'ISO basso', '低ISO優先', '저 ISO 우선', 'Lage ISO', 'Niskie ISO', 'ISO baixo',
  'Низкая ISO', '低 ISO 优先', 'ISO bajo', 'Låg ISO', 'ISO ต่ำ', '低 ISO 優先', 'Düşük ISO',
];
export const DF_MAX_SYNC_NAMES: readonly string[] = [
  'Max. synchronizace', 'Maks. synk.', 'Max Sync Speed', 'Maks. synkronointi', 'Synchro max.', 'Max. Synchronzeit', 'Μέγ. συγχρονισμός',
  'Max. szinkron', 'Sincro max.', '同調上限優先', '동조 상한 우선', 'Max. synchronisatie', 'Maks. synchronizacja', 'Sincronização máx.',
  'Макс. синхронизация', '同步上限优先', 'Sincro. máx.', 'Max. synk', 'ซิงค์สูงสุด', '同步上限優先', 'Maks. senkron',
];

/** Test 060: Standard (bits 6..7 = 0: the background as chosen, the sync limit raised by a smaller aperture and a higher ISO where needed), in `LANGS` order. */
export const DF_STANDARD_NAMES: readonly string[] = [
  'Standardní', 'Standard', 'Standard', 'Normaali', 'Standard', 'Standard', 'Τυπικό',
  'Normál', 'Standard', 'スタンダード', '표준', 'Standaard', 'Standardowy', 'Padrão',
  'Стандарт', '标准', 'Estándar', 'Standard', 'มาตรฐาน', '標準', 'Standart',
];

/**
 * Test 062: the fastest shutter speed for Direct Flash (byte 0x109, bits 0..2; see directflash.c):
 * the camera's flash-sync limit (0, the default), 1/2000, 1/1000, 1/500 and 1/250 s. A strong flash
 * at full power burns longer than a shutter of 1/2500 s or faster is open.
 */
export const DF_FASTEST: readonly { name: string; code: number }[] = [
  { name: 'sync', code: 0 }, { name: '1/2000', code: 1 }, { name: '1/1000', code: 2 }, { name: '1/500', code: 3 }, { name: '1/250', code: 4 },
];
/** The line name, in `LANGS` order (the camera's own Minimum Shutter Speed, text 125, turned round). */
export const DF_FASTEST_NAMES: readonly string[] = [
  'Nejkratší čas závěrky', 'Maks. lukkerhastighed', 'Maximum Shutter Speed', 'Lyhin suljinaika', 'Vitesse obturation max.',
  'Kürzeste Verschlusszeit', 'Μέγ.Ταχύτ.Κλείστρου', 'Maximális zársebesség', 'Tempo posa più breve', '高速限界値', '고속한계치',
  'Kortste sluitertijd', 'Maks. prędk. migawki', 'Veloc. obturação máxima', 'Кратчайш. выдержка', '最高快门速度', 'Velocidad obturador máx.',
  'Kortaste slutartid', 'ความเร็วชัตเตอร์สูงสุด', '最高快門速度', 'Maks. Enstantane Hızı',
];
/** The first value: the camera's own flash-sync limit, in `LANGS` order. */
export const DF_SYNC_LIMIT_NAMES: readonly string[] = [
  'Limit synchr.', 'Synk.-grænse', 'Sync Limit', 'Synkr. raja', 'Limite synchro', 'Sync-Grenze', 'Όριο συγχρ.',
  'Szinkronhatár', 'Limite sincro', '同調上限', '동조 상한', 'Synchrolimiet', 'Limit synchr.', 'Limite sincro.',
  'Предел синхр.', '同步上限', 'Límite sincro.', 'Synkgräns', 'ขีดจำกัดซิงค์', '同步上限', 'Senk. sınırı',
];

export const dfBackgroundName = (k: number): string => `-${(k / 3).toFixed(1)} EV`;
export const dfGuideNumberName = (gn: number): string => `GN ${gn}`;
const same = (text: string): string[] => Array(LANGUAGES).fill(text) as string[];

/** One list: values (menu order) and how each is stored in a field of a setting byte. */
export interface DfList {
  id: number;
  /** Line name and list title. */
  title: number;
  byte: number;
  shift: number;
  mask: number;
  /** Stored field value per list position. */
  codes: readonly number[];
  /** List position shown for a field value no position has. */
  fallback: number;
  /** Per value, the name in the 21 languages (`LANGS` order). */
  names: readonly (readonly string[])[];
  firstText: number;
  firstIcon: number;
  icons: readonly Uint8Array[];
}

/** The five lists, in the submenu's order. */
export function directFlashLists(): DfList[] {
  const gnCodes = DF_GUIDE_NUMBERS.map((g) => (g === DF_GN_DEFAULT ? 0 : g));
  const bgCodes = DF_BACKGROUND_THIRDS.map((k) => (k === DF_BACKGROUND_DEFAULT ? 0 : k));
  let text = DF_TEXT_ID + 4;
  let icon = DF_ICON_ID;
  const make = (id: number, title: number, byte: number, shift: number, mask: number, codes: number[], names: string[][], icons: Uint8Array[]): DfList => {
    const l: DfList = { id, title, byte, shift, mask, codes, fallback: codes.indexOf(0), names, firstText: text, firstIcon: icon, icons };
    text += codes.length;
    icon += codes.length;
    return l;
  };
  return [
    make(DF_GN_ID, DF_TEXT_ID + 1, DIRECT_FLASH_GN_BYTE, 0, DF_GN_MASK, gnCodes, DF_GUIDE_NUMBERS.map((g) => same(dfGuideNumberName(g))),
      DF_GUIDE_NUMBERS.map((g) => drawValueIcon('GN', String(g)))),
    make(DF_BACKGROUND_ID, DF_TEXT_ID + 2, DIRECT_FLASH_BYTE, DF_BACKGROUND_SHIFT, 15, bgCodes, DF_BACKGROUND_THIRDS.map((k) => same(dfBackgroundName(k))),
      DF_BACKGROUND_THIRDS.map((k) => drawValueIcon('EV', `-${(k / 3).toFixed(1)}`))),
    make(DF_SLOWEST_ID, TEXT_MIN_SHUTTER, DIRECT_FLASH_BYTE, DF_SLOWEST_SHIFT, 7, DF_SLOWEST.map((x) => x.code), DF_SLOWEST.map((x) => same(x.name)),
      DF_SLOWEST.map((x) => (x.name.startsWith('1/') ? drawValueIcon('1/', x.name.slice(2)) : drawValueIcon('SEC', '1')))),
    // Test 060: Standard (0; also 1 and 3, test 059's Max Sync and an unused value) and Max Sync (2, test 059's Fastest Shutter).
    make(DF_PRIORITY_ID, DF_TEXT_ID + 3, DIRECT_FLASH_GN_BYTE, DF_PRIORITY_SHIFT, 3, [0, 2], [[...DF_STANDARD_NAMES], [...DF_MAX_SYNC_NAMES]],
      [drawValueIcon('STD', 'TV'), drawValueIcon('MAX', 'TV')]),
    // Test 062: its line name comes after all the values' texts (DF_FASTEST_TEXT_ID).
    make(DF_FASTEST_ID, DF_FASTEST_TEXT_ID, DIRECT_FLASH_TV_BYTE, 0, 7, DF_FASTEST.map((x) => x.code),
      DF_FASTEST.map((x) => (x.code === 0 ? [...DF_SYNC_LIMIT_NAMES] : same(x.name))),
      DF_FASTEST.map((x) => (x.code === 0 ? drawValueIcon('MAX', 'SYNC') : drawValueIcon('1/', x.name.slice(2))))),
  ];
}

// --------------------------------------------------------------------------------------------
// Icons: the tile of the camera's menu icons (grey border, dark fill), a small label over the value.

/** 5x7 glyphs (narrower for 1 I - . /), '#' = ink. */
const GLYPHS: Record<string, readonly string[]> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['.#.', '##.', '.#.', '.#.', '.#.', '.#.', '###'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '-': ['...', '...', '...', '###', '...', '...', '...'],
  '.': ['.', '.', '.', '.', '.', '.', '#'],
  '/': ['..#', '..#', '.#.', '.#.', '.#.', '#..', '#..'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  V: ['#...#', '#...#', '#...#', '#...#', '.#.#.', '.#.#.', '..#..'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
};

export const DF_ICON_W = 40;
export const DF_ICON_H = 40;

/** 40x40 RGBA: `label` (small, light grey) over `value` (twice as large, white). */
export function drawValueIcon(label: string, value: string): Uint8Array {
  const W = DF_ICON_W;
  const H = DF_ICON_H;
  const ink = new Uint8Array(W * H);
  const draw = (text: string, scale: number, y0: number, colour: number, sx = scale): void => {
    const glyphs = [...text].map((c) => {
      const g = GLYPHS[c];
      if (!g) throw new FirmwareError('internal', `no icon glyph for ${c}`);
      return g;
    });
    // One pixel of space between glyphs (the large row's glyphs are two pixels per column).
    const space = (k: number): number => (k < glyphs.length - 1 ? (sx === 1 ? 1 : 2 - Number(text[k] === '.' || text[k + 1] === '.')) : 0);
    const width = glyphs.reduce((n, g, k) => n + g[0].length * sx + space(k), 0);
    if (width > (sx === scale ? 32 : 34)) throw new FirmwareError('internal', `icon text too wide: ${text}`);
    let x = Math.floor((W - width) / 2);
    glyphs.forEach((g, k) => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < g[r].length; c++) {
          if (g[r][c] !== '#') continue;
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < sx; dx++) ink[(y0 + r * scale + dy) * W + x + c * sx + dx] = colour;
        }
      }
      x += g[0].length * sx + space(k);
    });
  };
  draw(label, 1, 6, 1);
  // Test 062: a value too wide at twice the size (four digits, SYNC) is drawn twice as high only.
  const chars = [...value];
  const wide = chars.reduce((n, c, k) => n + (GLYPHS[c] ? GLYPHS[c][0].length * 2 : 0)
    + (k < chars.length - 1 ? 2 - Number(c === '.' || chars[k + 1] === '.') : 0), 0) > 32;
  draw(value, 2, 18, 2, wide ? 1 : 2);
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (x < 1 || y < 1 || x > 38 || y > 38) px.set([255, 255, 255, 0], i);
      else if (x === 1 || y === 1 || x === 38 || y === 38) px.set([128, 128, 128, 255], i);
      else px.set(ink[y * W + x] === 2 ? [255, 255, 255, 255] : ink[y * W + x] === 1 ? [190, 190, 190, 255] : [53, 53, 54, 255], i);
    }
  }
  return px;
}

// --------------------------------------------------------------------------------------------

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}
const lo = (v: number): number => v & 0xffff;
const hi = (v: number): number => v >>> 16;

/** Flash Mode's submenu (record 5) as the official firmware has it. */
const FLASH_SUBMENU = 5;
const FLASH_MODE_LINE_ID = 0x020000f3;
const FLASH_OUTPUT_LINE_ID = 0x020000f6;
const TEXT_FLASH_MODE = 127;
const TEXT_FLASH_OUTPUT = 137;
const VALUE_X = 540;

/** ip = the list position of the stored field (or the fallback); r0, r2, r3 change. */
function indexAsm(l: DfList, table: number): string {
  return `movw r2, #${lo(l.byte)}; movt r2, #${hi(l.byte)}; ldrb r3, [r2]
    ${l.shift ? `mov r3, r3, lsr #${l.shift}` : ''}
    and r3, r3, #${l.mask}
    movw r2, #${lo(table)}; movt r2, #${hi(table)}
    mov ip, #0
    idx_loop: ldrb r0, [r2, ip]; cmp r0, r3; beq idx_done
    add ip, ip, #1; cmp ip, #${l.codes.length}; blo idx_loop
    mov ip, #${l.fallback}
    idx_done:`;
}

function installTexts(patch: Patch, entries: readonly { id: number; names: readonly string[] }[]): void {
  const upper = Math.max(...entries.map((x) => x.id));
  widenTextRows(patch, upper);
  for (const { id, names } of entries) {
    if (names.length !== LANGUAGES) fail('internal', 'a text needs all 21 languages');
    const descriptors = names.map((text) => {
      const encoded = utf16z(text);
      const units = encoded.length / 2;
      if (!(units > 1 && units < 256) || text.includes('\n')) fail('internal', 'bad menu text');
      const address = patch.append(encoded, 4);
      // {u8 units including the terminator, u8 lines = 1, u16 0, u32 text address}
      return patch.append(concat([Uint8Array.from([units, 1, 0, 0]), u32le([address])]), 4);
    });
    for (let l = 0; l < LANGUAGES; l++) {
      const row = patch.word(TEXT_CATALOG + l * 4);
      if (patch.word(row + id * 4) !== 0) fail('unexpected-layout', 'text number already in use');
      patch.write(row + id * 4, u32le([descriptors[langIndex(patch, l)]]));
    }
  }
}

/** The `LANGS` index of language row l (as the program indexes languages). */
const FIRST_TABLE_RAM = 0x55000000 + (0x5437d7b0 - 0x5437b640);
const TABLE_STRIDE = 0xd14;
const NATIVE_TEXT_ROOTS = 0x55002118;
function langIndex(patch: Patch, l: number): number {
  const root = new DataView(patch.readMapped(NATIVE_TEXT_ROOTS + l * 4, 4).buffer).getUint32(0, true);
  const k = (root + 4 - FIRST_TABLE_RAM) / TABLE_STRIDE;
  if (!(Number.isInteger(k) && k >= 0 && k < LANGUAGES)) fail('unexpected-layout', 'language tables are not where they were expected');
  return k;
}

function installIcons(patch: Patch, iconbin: Uint8Array, icons: readonly { id: number; px: Uint8Array }[]): Uint8Array {
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
    // {u16 kind = 1, u16 width, u16 height, u16 flags = 0, u32 offset in 4-byte units}
    const descriptor = patch.append(concat([u16le([1, DF_ICON_W, DF_ICON_H, 0]), u32le([offset / 4])]), 16);
    patch.write(ICON_CATALOG + id * 4, u32le([descriptor]));
  }
  const upper = Math.max(...icons.map((x) => x.id));
  for (const [site, register] of LOOKUP_BOUNDS) {
    if ((patch.word(site) & 0xfff0f000) >>> 0 !== (0xe3000000 | (register << 12)) >>> 0) fail('unexpected-layout', 'icon bound is not a MOVW');
    patch.setWord(site, movWord(register, Math.max(upper, movImmediate(patch.word(site)))), 'icon upper bound');
  }
  return concat(parts);
}

/**
 * 0.8.6: MENU after coming back from Direct Flash Settings. Every submenu is one SubMenuController
 * (the factory keeps a single instance, +0xC4). Its back target is +0x150; when a line opens a
 * submenu nested in this one, OK (0x531E20A8) first keeps +0x150 at +0x17C, and on the way back
 * (0x531E2140) a submenu that is not nested takes it again from +0x17C. The firmware does that for
 * its own two nested submenus only, Pairing (0x020000D5) and Smartphone Link's 0x02000124; for
 * any other id the Flash submenu came back with no back target, so MENU did nothing (0.8.4 / 0.8.5).
 * Both checks now count DF_MENU_ID as nested too.
 */
const NESTED_OPEN = 0x531e20fc; // mov r3,#0x124; movt r3,#0x200; cmp r5,r3; beq keep
const NESTED_OPEN_KEEP = 0x531e212c, NESTED_OPEN_ON = 0x531e210c;
const NESTED_BACK = 0x531e2164; // mov r3,#0x124; movt r3,#0x200; cmp r0,r3; beq done
const NESTED_BACK_DONE = 0x531e2188, NESTED_BACK_ON = 0x531e2174;

function installNestedBack(patch: Patch): void {
  for (const [at, cmp, beq] of [[NESTED_OPEN, 0xe1550003, 0x0a000007], [NESTED_BACK, 0xe1500003, 0x0a000004]]) {
    expectWord(patch, at, 0xe3a03f49);
    expectWord(patch, at + 4, 0xe3403200);
    expectWord(patch, at + 8, cmp);
    expectWord(patch, at + 12, beq);
  }
  const stub = (reg: string, hit: number, miss: number): number => patch.append((a) => assembleWords(
    `mov r3, #0x124; movt r3, #0x200; cmp ${reg}, r3; beq #${hit}
     movw r3, #${lo(DF_MENU_ID)}; movt r3, #${hi(DF_MENU_ID)}; cmp ${reg}, r3; beq #${hit}
     b #${miss}`, a), 16);
  const open = stub('r5', NESTED_OPEN_KEEP, NESTED_OPEN_ON);
  const back = stub('r0', NESTED_BACK_DONE, NESTED_BACK_ON);
  patch.setWord(NESTED_OPEN, branchWord(NESTED_OPEN, open), 'Direct Flash settings: a nested submenu keeps the back target');
  patch.setWord(NESTED_BACK, branchWord(NESTED_BACK, back), 'Direct Flash settings: the back target again on the way back');
}

/** The Smartphone Link submenu (record 14), the model of the new submenu: four lines with value icons. */
const MODEL_SUBMENU = 14;
const MODEL_LINE_IDS = [0x020000dc, 0x02000124, 0x020000dd, 0x020000de];

/**
 * Install the settings. Runs after every other camera-menu addition that copies the submenu or
 * list table (date imprint, power-off pictures). Returns the ICONBIN data with the icons appended.
 */
export function installDirectFlashMenu(patch: Patch, iconbin: Uint8Array): Uint8Array {
  const lists = directFlashLists();
  for (const l of lists) if (l.codes.length > 21 || l.fallback < 0) fail('internal', 'Direct Flash list');
  expectWord(patch, SUB_SET_ICON, 0xe1a0c00d);
  expectWord(patch, LIST_SET_ITEM, 0xe1a0c00d);

  // --- Texts and icons.
  installTexts(patch, [
    { id: DF_TEXT_ID, names: DF_MENU_NAMES },
    { id: DF_TEXT_ID + 1, names: DF_GN_NAMES },
    { id: DF_TEXT_ID + 2, names: DF_BACKGROUND_NAMES },
    { id: DF_TEXT_ID + 3, names: DF_PRIORITY_NAMES },
    { id: DF_FASTEST_TEXT_ID, names: DF_FASTEST_NAMES },
    ...lists.flatMap((l) => l.names.map((names, i) => ({ id: l.firstText + i, names }))),
  ]);
  const icons = installIcons(patch, iconbin, lists.flatMap((l) => l.icons.map((px, i) => ({ id: l.firstIcon + i, px }))));

  // --- Lists (this = r0; draw: item = r1, value = r2; set / is current: value = r1) and the
  // submenu lines' value icons (line = r1).
  const template = listTemplate(patch);
  const records: { id: number; record: Uint8Array }[] = [];
  const lineDraws: number[] = [];
  for (const l of lists) {
    const n = l.codes.length;
    const table = patch.append(Uint8Array.from(l.codes), 4);
    const count = patch.append((at) => assembleWords(`mov r0, #${n}; bx lr`, at), 16);
    const draw = patch.append((at) => assembleWords(
      `cmp r2, #${n}; bxhs lr
       mov r0, r1
       movw r1, #${l.firstIcon}; add r1, r1, r2
       movw r3, #${l.firstText}; add r2, r3, r2
       b #${LIST_SET_ITEM}`, at), 16);
    const set = patch.append((at) => assembleWords(
      `cmp r1, #${n}; bxhs lr
       movw r2, #${lo(table)}; movt r2, #${hi(table)}; ldrb r3, [r2, r1]
       movw r2, #${lo(l.byte)}; movt r2, #${hi(l.byte)}; ldrb ip, [r2]
       bic ip, ip, #${l.mask << l.shift}
       orr ip, ip, r3, lsl #${l.shift}
       strb ip, [r2]; bx lr`, at), 16);
    const current = patch.append((at) => assembleWords(
      `push {r4, lr}
       mov r4, r1
       ${indexAsm(l, table)}
       cmp ip, r4; moveq r0, #1; movne r0, #0
       pop {r4, pc}`, at), 16);
    lineDraws.push(patch.append((at) => assembleWords(
      `push {r4, lr}
       mov r4, r1
       ${indexAsm(l, table)}
       mov r0, r4
       movw r1, #${l.firstIcon}; add r1, r1, ip
       pop {r4, lr}
       b #${SUB_SET_ICON}`, at), 16));
    const r = template.slice();
    const v = new DataView(r.buffer);
    v.setUint16(4, l.title, true);
    v.setUint32(0x0c, count, true);
    v.setUint32(0x14, draw, true);
    v.setUint32(0x24, set, true);
    v.setUint32(0x2c, current, true);
    for (const off of [0x10, 0x18, 0x28, 0x30]) v.setUint32(off, 0, true);
    records.push({ id: l.id, record: r });
  }
  addListRecords(patch, records, 'Direct Flash settings');
  const listIds = lists.map((l) => l.id);
  if (Math.min(...listIds) !== DF_GN_ID || Math.max(...listIds) !== DF_FASTEST_ID || DF_MENU_ID <= DF_GN_ID || DF_MENU_ID >= DF_PRIORITY_ID) fail('internal', 'Direct Flash ids');
  hookControllerFactory(patch, `movw ip, #${lo(DF_GN_ID)}; movt ip, #${hi(DF_GN_ID)}
     sub ip, r1, ip; cmp ip, #${DF_FASTEST_ID - DF_GN_ID}; bhi prior
     cmp ip, #${DF_MENU_ID - DF_GN_ID}
     movweq r1, #${lo(SUBMENU_CONTROLLER_ID)}; movteq r1, #${hi(SUBMENU_CONTROLLER_ID)}
     movwne r1, #${lo(LIST_CONTROLLER_ID)}; movtne r1, #${hi(LIST_CONTROLLER_ID)}`, 'Direct Flash settings: submenu and list controllers');

  // --- The submenu: Smartphone Link's record with our title, lines, ids and value icons.
  const model = patch.read(submenuTable(patch) + MODEL_SUBMENU * SUB_RECORD, SUB_RECORD);
  const mv = new DataView(model.buffer);
  if (model[6] !== 4 || MODEL_LINE_IDS.some((id, k) => mv.getUint32(0x14 + 4 * k, true) !== id) || mv.getUint32(0x24, true) !== 0x10000000
    || [0, 1, 2, 3].some((k) => mv.getUint32(0x28 + 4 * k, true) !== VALUE_X) || mv.getUint32(0x38, true) !== 0 || mv.getUint16(16, true) !== 0) {
    fail('unexpected-layout', 'Smartphone Link submenu record is not as expected');
  }
  const sub = model.slice();
  const sv = new DataView(sub.buffer);
  sv.setUint16(2, DF_TEXT_ID, true);
  // Test 062: five lines, the most a submenu record has (record 10 of the firmware's own has five:
  // titles to +0x10, ids to +0x24, value x to +0x38, line draws to +0x5C).
  if (lists.length > 5) fail('internal', 'Direct Flash submenu lines');
  sub[6] = lists.length;
  for (let k = 4; k < lists.length; k++) sv.setUint32(0x28 + 4 * k, VALUE_X, true);
  lists.forEach((l, k) => {
    sv.setUint16(8 + 2 * k, l.title, true);
    sv.setUint32(0x14 + 4 * k, l.id, true);
    sv.setUint32(0x3c + 8 * k, lineDraws[k], true);
    sv.setUint32(0x40 + 8 * k, 0, true);
  });
  addSubmenuRecord(patch, DF_MENU_ID, sub, 'Direct Flash settings');
  installNestedBack(patch);

  // --- Flash Mode's submenu: a third line that opens it (no value icon, as Wireless > Pairing).
  const rec = submenuTable(patch) + FLASH_SUBMENU * SUB_RECORD;
  const old = patch.read(rec, SUB_RECORD);
  const ov = new DataView(old.buffer);
  if (ov.getUint16(2, true) !== TEXT_FLASH_MODE || old[6] !== 2 || ov.getUint16(8, true) !== TEXT_FLASH_MODE || ov.getUint16(10, true) !== TEXT_FLASH_OUTPUT
    || ov.getUint16(12, true) !== 0 || ov.getUint32(0x14, true) !== FLASH_MODE_LINE_ID || ov.getUint32(0x18, true) !== FLASH_OUTPUT_LINE_ID
    || ov.getUint32(0x1c, true) !== 0x10000000 || ov.getUint32(0x28, true) !== VALUE_X || ov.getUint32(0x2c, true) !== VALUE_X || ov.getUint32(0x30, true) !== 0
    || ov.getUint32(0x4c, true) !== 0) {
    fail('unexpected-layout', 'Flash Mode submenu record is not as expected');
  }
  const r = old.slice();
  const v = new DataView(r.buffer);
  r[6] = 3;
  v.setUint16(12, DF_TEXT_ID, true);
  v.setUint32(0x1c, DF_MENU_ID, true);
  v.setUint32(0x30, VALUE_X, true);
  // Word by word: the record may be the official one (no other addition copied the table).
  for (let o = 0; o < SUB_RECORD; o += 4) {
    const w = v.getUint32(o, true);
    if (w !== ov.getUint32(o, true)) patch.setWord(rec + o, w, 'Direct Flash settings: Flash Mode submenu line');
  }
  return icons;
}
