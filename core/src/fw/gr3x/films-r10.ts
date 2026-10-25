// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60, round 10: the films as looks of their own, GR IV's way
 * (../aspect/slots.ts). Films are looks 64..63 + n, as in rounds 6..9 (so the settings, the date
 * imprint's tables and the lists keep their numbers).
 *
 * The picture (read from the official 2.10 code):
 *  - GR III has three tables by look (26 entries): 0x55018d94 (the tone record: colour matrix, the
 *    nine saturation matrices, the YCbCr operation words), 0x55018cf0 (multi-axis colour) and
 *    0x55018e4c (YCbCr matrix), read in one place, the descriptor builder 0x536dc0f4 (stills and
 *    live view), with no bound: 0x536dc28c/0x536dc294, 0x536dc290/0x536dc298, 0x536dc2a4/0x536dc2a8.
 *    They are copied with 84 entries (26..63 Standard's, film k at 64 + k: its own tone record;
 *    Standard's multi-axis and YCbCr), and the builder reads the film's look as it is (GR IV: the
 *    four style tables extended). Up to round 9 the film read as Standard there and a hook gave the
 *    descriptor the film's record.
 *  - GR III has no table of tone curves (its gamma is computed from the parameters) and no
 *    post-curve matrix of a look (its saturation matrices are applied before the curves, GR IV's
 *    after): a film's curves and post-curve matrix still come through image-control.ts's hooks.
 *  - Where the camera decides something from the look the film is taken locally as Standard
 *    (GR IV: as Cinema Yellow): the development step (0x536db7f8), the black-and-white test of the
 *    descriptor (0x536dc4bc), the digital-filter decision (0x535131c0), 0x536dd3e0 (look table
 *    0x53dbd1b0, guarded), the shooting-mode restriction (0x53553ad4). The other reads of the look
 *    (the Cross Processing keeper, the white balance's tests for 21 and 9, the gamma's test for 16,
 *    the contents writer's test for 21, the live view's change detection) behave as for Standard
 *    with any other look and stay as they are.
 *
 * The parameters (native/films.c): the films borrow Bleach Bypass's (18): Standard's nine and a
 * Toning byte, in every photo and movie set; the Toning byte holds the film's Halation (GR IV's
 * states, halation-rows.ts shows them as two rows). Rendering takes the film as Standard, whose
 * parameters are the same without the Toning, so the byte reaches no picture step.
 *  - the parameter setters (SetSaturation ..., 0x532bd784..) take the look from 0x53549ee8 and
 *    dispatch on it: a film as 18;
 *  - each of Bleach Bypass's 57 field setters (30 photo, 27 movie) has an active check comparing the
 *    set's look with 18 before the live value is updated; the camera's full sync (0x532750f8, after
 *    every change of look) calls the same checks: a film passes as 18;
 *  - the default getters (GetDefaultValue..., 0x532c34e8..): the neutral value of a film for the
 *    parameters Bleach Bypass has (what the screen marks as "0"), the fixed neutral ones otherwise;
 *  - the look of a set's setters (photo 0x5327b394.., movie 0x5327b54c..) swap the owners' values
 *    (films.c) before they run; settings load and save through the settings scaffold (round10.ts);
 *    a mode recall puts the owners' values in the table first;
 *  - the main menu's Image Control line (GetStillDispImageControl 0x5326c1cc, GetMovieDisp...
 *    0x5326c380: set 0's look through a switch up to 22, then Standard) answers a film itself, as
 *    GR IV's installLookChecks.
 * Bleach Bypass's own Toning stays 1..3 in its fields (the owners swap); where the camera reads it
 * a value outside that counts as 1, as GR IV keeps its Toning readers to 0..2: the development step
 * (0x536dbd48) and the slider's position map (0x531ac654).
 *
 * RAW development (GR IV installRawDevelopment): its own numbering (0 as shot, 1..12 the looks in
 * menu order): the films are 13 + k (0x53288d5c style to RAW, 0x53289058 back). The model keeps 17
 * bytes per base (the three photo sets) and look; the 62 functions that turn a look into a row
 * (`ldrb r2,[r3,#0x83]` at 61 places, `ldrb r1,...` at 0x532846e8) take a film as Bleach Bypass (9),
 * whose row belongs to one owner per base (films.c sp_raw_*: after the model fills every look,
 * 0x532899b4; the parameters a file was shot with, 0x53289a14; applying a look, 0x53289240). The
 * Image Control list of RAW development (0x53283358 count, 0x532834d0 base, 0x532834f0 look of an
 * entry; GR III's fixed tables) gets the films after the camera's looks (in the layout's order when
 * there is one), and its capacity (0x532833bc) grows. A film's parameter screen in RAW development
 * shows Standard's lines (0x5318dea0; GR III's RAW screen has no rows of its own for the Halation).
 *
 * The picture's information (GR IV installPictureInfo):
 *  - the maker note's look (ImageTone, writer 0x535c780c): a film writes 0x8110 + k (GR IV's codes;
 *    GR III's own are 0x100..0x10b); RAW development's record of a file (0x535bf7c4), playback's
 *    numbering (0x535c2508: films 13 + k) and its style (0x532b44dc) read them back; playback's
 *    parameter page shows a film's as Standard's (0x532b7d10), its icon is the film's (0x532b6f3c);
 *  - the parameters: each writer (CommonPentaxMakernoteEntryDataSetter) writes a parameter as absent
 *    for the looks of a list (built at start, 0x535ca050); the films join every list Bleach Bypass is
 *    in. Bleach Bypass's Toning (writer 0x535c5e34, codes 0..2 for 1..3) writes a film's Halation
 *    state s as 0x100 + s, which the reader (0x535c0d04) gives back (GR IV: codes 4..12).
 */
import { branchWord, movWord, wordsToBytes } from '../aspect/arm';
import { linkModule } from '../aspect/native-link';
import { FirmwareError } from '../types';
import { GR3X_FILMS_MODULE } from './films-native';
import { GR3X_R10, GR3X_SETTINGS_LOAD, GR3X_SETTINGS_SAVE, gr3xSettingsHook, gr3xSettingsPrior } from './round10';
import type { Gr3xSite } from './round10';

export const GR3X_BLEACH = 18;
export const GR3X_FILM_LOOKS = 84;
const STANDARD = 11, FIRST = 64;
const fail = (m: string): never => { throw new FirmwareError('unexpected-instruction', `IIIx round 10: ${m}`); };
const lo = (v: number) => v & 0xffff, hi = (v: number) => v >>> 16;
const addr = (r: string, a: number) => `movw ${r},#${lo(a)};movt ${r},#${hi(a)};`;
const bl = (at: number, target: number) => (0xeb000000 | (((target - (at + 8)) >> 2) & 0xffffff)) >>> 0;

export interface Gr3xR10Program {
  code(source: string): number;
  append(bytes: Uint8Array): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  /** The camera's own word / bytes (before any patch). */
  u32(address: number): number;
  read(address: number, size: number): Uint8Array;
  sites: Gr3xSite[];
  /** The next code address (the module is placed there). */
  next(): number;
}

/** A film of the build: its look, its tone record (in the appended data), icon. */
export interface Gr3xR10Film { id: number; record: number; iconId: number; print: number }

const u32le = (words: readonly number[]) => wordsToBytes(words.map(w => w >>> 0));

// ------------------------------------------------------------------ the three tables
const TONE_TABLE = 0x55018d94, MA_TABLE = 0x55018cf0, YCC_TABLE = 0x55018e4c;
/** [table, register, movw, movt] as the builder loads them. */
const TABLE_SITES = [[TONE_TABLE, 0, 0x536dc28c, 0x536dc294], [MA_TABLE, 12, 0x536dc290, 0x536dc298], [YCC_TABLE, 0, 0x536dc2a4, 0x536dc2a8]] as const;
const TABLE_INDEX = [[0x536dc2a0, 0xe790e101], [0x536dc2b0, 0xe79cc101], [0x536dc2bc, 0xe7901101]] as const;

export function installGr3xR10Tables(p: Gr3xR10Program, films: readonly Gr3xR10Film[]) {
  for (const [at, w] of TABLE_INDEX) if (p.u32(at) !== w) fail(`descriptor table index at ${at.toString(16)}`);
  const out: number[] = [];
  TABLE_SITES.forEach(([table, r, low, high], t) => {
    if (p.u32(low) !== movWord(r, lo(table)) || p.u32(high) !== movWord(r, hi(table), true)) fail(`descriptor table at ${low.toString(16)}`);
    const native = Array.from({ length: 26 }, (_, i) => new DataView(p.read(table + 4 * i, 4).buffer).getUint32(0, true));
    const words = Array.from({ length: GR3X_FILM_LOOKS }, (_, i) => i < 26 ? native[i] : native[STANDARD]);
    films.forEach(f => { if (t === 0) words[f.id] = f.record; });
    const copy = p.append(u32le(words));
    p.patch(low, movWord(r, lo(table)), movWord(r, lo(copy)), 'films as looks: descriptor table by look (84 entries), low half');
    p.patch(high, movWord(r, hi(table), true), movWord(r, hi(copy), true), 'films as looks: descriptor table by look (84 entries), high half');
    out.push(copy);
  });
  return { toneTable: out[0], multiAxisTable: out[1], yccTable: out[2] };
}

/** The four words the camera's start-up gives every native tone record (0x536eb0e4) at words 17..20. */
export const GR3X_TONE_RECORD_TAIL = 0x53dc27a4;

// ------------------------------------------------------------------ parameters
/** The parameter setters' call of the current look (GR3X_PARAMETER_SETTER_LOOKS) and its target. */
const CURRENT_LOOK = 0x53549ee8;
/** Bleach Bypass's active checks: [site, word] (P0 / M0 `ldr r3,[r3,#0x1c0 / 0x57c]`, then `cmp r3,#0x120000`;
 * the others `ldrb r3,[r3,#0x1c4 / 0x1c6 / 0x580 / 0x582]`, then `cmp r3,#18`). */
export const GR3X_BLEACH_CHECKS: readonly (readonly [number, number])[] = [
  ...[0x5325bb34, 0x5325bdbc, 0x5325c1f4, 0x5325c5c0, 0x5325c98c, 0x5325cd58, 0x5325d124, 0x5325d3ac, 0x5325d7e4, 0x5325db44].map(a => [a, 0xe59331c0] as const),
  ...[0x5325df9c, 0x5325e23c, 0x5325e69c, 0x5325ea8c, 0x5325ee7c, 0x5325f26c, 0x5325f65c, 0x5325f8fc, 0x5325fd5c, 0x532600dc].map(a => [a, 0xe5d331c4] as const),
  ...[0x5326053c, 0x532607dc, 0x53260c3c, 0x5326102c, 0x5326141c, 0x5326180c, 0x53261bfc, 0x53261e9c, 0x532622fc, 0x5326267c].map(a => [a, 0xe5d331c6] as const),
  ...[0x53262bd4, 0x53262e68, 0x53263288, 0x532636a8, 0x53263ac8, 0x53263ee8, 0x53264308, 0x5326459c, 0x532649bc].map(a => [a, 0xe593357c] as const),
  ...[0x53264c68, 0x53264f10, 0x53265350, 0x53265790, 0x53265bd0, 0x53266010, 0x53266450, 0x532666f8, 0x53266b38].map(a => [a, 0xe5d33580] as const),
  ...[0x53266de0, 0x53267088, 0x532674c8, 0x53267908, 0x53267d48, 0x53268188, 0x532685c8, 0x53268870, 0x53268cb0].map(a => [a, 0xe5d33582] as const),
];
/** The photo / movie "look of set n" setters. */
const STYLE_SETTERS = [[0x5327b394, 0xe5903004, 'ldr r3,[r0,#4]'], [0x5327b3b4, 0xe5903004, 'ldr r3,[r0,#4]'], [0x5327b3d4, 0xe5903004, 'ldr r3,[r0,#4]'],
  [0x5327b54c, 0xe1a03000, 'mov r3,r0'], [0x5327b584, 0xe1a03000, 'mov r3,r0'], [0x5327b5bc, 0xe1a03000, 'mov r3,r0']] as const;
const MENU_ROWS = [[0x5326c238, 0x5326c22c], [0x5326c3ec, 0x5326c3e0]] as const;
const DEV_TONING = 0x536dbd48, SLIDER_MAP = 0x531ac654;
const STORAGE = 0x53828014, STORE_WRITE = 0x53829a08, STORE_READ = 0x53829fcc, STORE_SIZE = 0x53829e50, HEAP_ALLOC = 0x536af2a8;
export const GR3X_SETTINGS_OBJECT = 0x55063f30;
/** Default getters [entry, CommonProperty byte] (image-control.ts's DEFAULTS; Cross Processing's toning is 0x797). */
const DEFAULT_GETTERS: readonly (readonly [number, number])[] = [
  [0x532c34e8, 0x77d], [0x532c3b54, 0x77e], [0x532c41c0, 0x77f], [0x532c494c, 0x780], [0x532c50d8, 0x781], [0x532c5864, 0x782],
  [0x532c5ff0, 0x784], [0x532c677c, 0x785], [0x532c6b94, 0x786], [0x532c6e38, 0x787], [0x532c70e4, 0x788], [0x532c7270, 0x797],
  [0x532c7520, 0x78a], [0x532c78a8, 0x78c], [0x532c7f0c, 0x78e], [0x532c8570, 0x790], [0x532c8bd4, 0x793], [0x532c9360, 0x794],
  [0x532c9744, 0x795], [0x532c9a20, 0x796],
];
/** A film's default (neutral) value per CommonProperty byte: 4 on the -4..+4 scales, 0 otherwise (Halation off, no filter / grain / HDR). */
const FILM_DEFAULT: Readonly<Record<number, number>> = { 0x77d: 4, 0x77e: 4, 0x77f: 4, 0x780: 4, 0x781: 4, 0x782: 4, 0x784: 4, 0x785: 0,
  0x786: 0, 0x787: 4, 0x788: 1, 0x797: 0, 0x78a: 0, 0x78c: 0, 0x78e: 0, 0x790: 0, 0x793: 4, 0x794: 4, 0x795: 0, 0x796: 0 };

export interface Gr3xR10ParameterOptions {
  films: number;
  /** Prints of the films (`gr3xFilmPrint`), then the hidden films' word. */
  prints: readonly number[];
  hiddenMask: number;
  setterSites: readonly number[];
}

export function installGr3xR10Parameters(p: Gr3xR10Program, o: Gr3xR10ParameterOptions) {
  const n = o.films;
  if (!Number.isInteger(n) || n < 1 || n > 20 || o.prints.length !== n) fail('films');
  const isFilm = (r: string, tmp: string) => `sub ${tmp},${r},#${FIRST};cmp ${tmp},#${n - 1};`;
  // Setters: the current look as 18 for a film (the call's result, r0; lr, r1.. as the call leaves them).
  const setters = o.setterSites.map(at => {
    if (p.u32(at) !== bl(at, CURRENT_LOOK)) fail(`parameter setter at ${at.toString(16)}`);
    const stub = p.code(`push {lr};bl #${CURRENT_LOOK};sub ip,r0,#${FIRST};cmp ip,#${n - 1};movls r0,#${GR3X_BLEACH};pop {pc};`);
    p.patch(at, bl(at, CURRENT_LOOK), bl(at, stub), 'films as looks: parameter setters take a film as Bleach Bypass');
    return stub;
  });
  // Active checks: the loaded look byte (r3; for the ldr forms byte 2) a film -> 18; flags as before.
  const checks = GR3X_BLEACH_CHECKS.map(([at, word]) => {
    if (p.u32(at) !== word) fail(`active check at ${at.toString(16)}`);
    const next = p.u32(at + 4), wordForm = word === 0xe59331c0 || word === 0xe593357c;
    const offset = word & 0xfff;
    const stub = wordForm
      ? p.code(`push {r0,r1};mrs r0,cpsr;ldr r3,[r3,#${offset}];and r1,r3,#0xff0000;sub r1,r1,#${FIRST << 16};cmp r1,#${(n - 1) << 16};` +
        `bichi r3,r3,#0;bicls r3,r3,#0xff0000;orrls r3,r3,#${GR3X_BLEACH << 16};msr cpsr_f,r0;pop {r0,r1};b #${at + 4};`)
      : p.code(`push {r0};mrs r0,cpsr;ldrb r3,[r3,#${offset}];sub r3,r3,#${FIRST};cmp r3,#${n - 1};movls r3,#${GR3X_BLEACH};addhi r3,r3,#${FIRST};msr cpsr_f,r0;pop {r0};b #${at + 4};`);
    p.patch(at, word, branchWord(at, stub), 'films as looks: Bleach Bypass\'s active check counts a film');
    void next;
    return stub;
  });
  // Default getters (r1 the look): a film's neutral value; anything else as the camera's.
  const defaults = DEFAULT_GETTERS.map(([at, field]) => {
    if (p.u32(at) !== 0xe1a0c00d) fail(`default getter at ${at.toString(16)}`);
    const stub = p.code(`${isFilm('r1', 'ip')}movls r0,#${FILM_DEFAULT[field]};bxls lr;mov ip,sp;b #${at + 4};`);
    p.patch(at, 0xe1a0c00d, branchWord(at, stub), 'films as looks: a film\'s neutral parameter default');
    return stub;
  });
  // The module.
  const prints = p.append(u32le([...o.prints, o.hiddenMask]));
  const origin = p.next();
  const priorLoad = gr3xSettingsPrior(p, 'load'), priorSave = gr3xSettingsPrior(p, 'save');
  const mod = linkModule(GR3X_FILMS_MODULE, 'films', n, origin, {
    prior_native_save: priorSave, prior_native_load: priorLoad, storage_singleton: STORAGE, store_write: STORE_WRITE,
    store_read: STORE_READ, store_size: STORE_SIZE, heap_alloc: HEAP_ALLOC, sp_gap: GR3X_R10.slotState,
    settings_object: GR3X_SETTINGS_OBJECT, slot_prints: prints,
  });
  if (p.append(mod.code) !== origin) fail('module address changed');
  const sym = mod.symbols;
  gr3xSettingsHook(p, 'load', sym.sp_load, 'films: the settings load, then their table');
  gr3xSettingsHook(p, 'save', sym.sp_save, 'films: the settings save, then their table');
  void GR3X_SETTINGS_LOAD; void GR3X_SETTINGS_SAVE;
  // The look of a set: the owners' values are swapped before the camera's setter runs.
  const styles = STYLE_SETTERS.map(([at, word, first], c) => {
    if (p.u32(at) !== word || p.u32(at + 4) !== 0xe1a0c00d) fail(`look setter at ${at.toString(16)}`);
    const stub = p.code(`push {r0-r3,ip,lr};mov r2,#${c};bl #${sym.sp_style_set};pop {r0-r3,ip,lr};${first};b #${at + 4};`);
    p.patch(at, word, branchWord(at, stub), `films: the owners' values when the look of ${c < 3 ? 'photo' : 'movie'} set ${c % 3} changes`);
    return stub;
  });
  // The main menu's Image Control line (r3 set 0's look): a film is answered itself.
  const menuRows = MENU_ROWS.map(([at, done]) => {
    if (p.u32(at) !== 0xe3530016 || p.u32(at + 4) !== 0x979ff103) fail(`menu Image Control line at ${at.toString(16)}`);
    const stub = p.code(`${isFilm('r3', 'ip')}movls r0,r3;bls #${done};cmp r3,#0x16;b #${at + 4};`);
    p.patch(at, 0xe3530016, branchWord(at, stub), 'films as looks: the menu\'s Image Control line shows the film');
    return stub;
  });
  // Bleach Bypass's Toning as the camera reads it: 1..3 (anything else 1). The development step's
  // read keeps the flags (a table), the slider's map takes its argument in r0.
  if (p.u32(DEV_TONING) !== 0xe5d36786 || p.u32(DEV_TONING + 4) !== 0xe3a05000) fail('development step Toning');
  const clampTable = p.append(Uint8Array.from({ length: 256 }, (_, v) => v >= 1 && v <= 3 ? v : 1));
  const devToning = p.code(`ldrb r6,[r3,#0x786];${addr('r5', clampTable)}ldrb r6,[r5,r6];b #${DEV_TONING + 4};`);
  p.patch(DEV_TONING, 0xe5d36786, branchWord(DEV_TONING, devToning), 'Bleach Bypass Toning 1..3 for the development step');
  if (p.u32(SLIDER_MAP) !== 0xe1a0c00d) fail('Toning slider map');
  const sliderMap = p.code(`sub ip,r0,#1;cmp ip,#2;movhi r0,#1;mov ip,sp;b #${SLIDER_MAP + 4};`);
  p.patch(SLIDER_MAP, 0xe1a0c00d, branchWord(SLIDER_MAP, sliderMap), 'Bleach Bypass Toning 1..3 for its slider');
  return { setters, checks, defaults, module: origin, moduleSymbols: { ...sym }, prints, styles, menuRows, clampTable, devToning, sliderMap };
}

// ------------------------------------------------------------------ RAW development
const RAW_TO_STYLE = 0x53289058, STYLE_TO_RAW = 0x53288d5c;
const RAW_ROW_LOAD = 0xe5d32083, RAW_ROW_LOAD_R1 = 0xe5d31083, RAW_ROW_R1_SITE = 0x532846e8;
const RAW_MODEL = [0x53283400, 0x53289000] as const;
const RAW_ROW_SITES = 61;
const RAW_FILL = 0x532899b4, RAW_AS_SHOT = 0x53289a14, RAW_APPLY = 0x53289240, RAW_COLUMN = 0x5318dea0;
const RAW_COUNT = 0x53283358, RAW_BASE = 0x532834d0, RAW_LOOK = 0x532834f0, RAW_CAPACITY = 0x532833bc;
export const GR3X_RAW_FIRST_FILM = 13;
const RAW_BLEACH = 9;
/** The camera's RAW development numbers of its looks (menu order). */
const RAW_OF_STYLE: Readonly<Record<number, number>> = { 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6, 22: 7, 17: 8, 18: 9, 19: 10, 20: 11, 21: 12 };

export interface Gr3xR10RawOptions {
  films: number;
  /** The looks of the RAW development list in order (the camera's 12 and the films; the layout's order without hidden ones). */
  order: readonly number[];
  module: Record<string, number>;
}

export function installGr3xR10Raw(p: Gr3xR10Program, o: Gr3xR10RawOptions) {
  const n = o.films, R = GR3X_RAW_FIRST_FILM;
  const sym = o.module;
  // Style <-> RAW development number.
  if (p.u32(STYLE_TO_RAW) !== 0xe241100b || p.u32(RAW_TO_STYLE) !== 0xe1a0c00d) fail('RAW development numbering');
  const toRaw = p.code(`sub ip,r1,#${FIRST};cmp ip,#${n - 1};addls r0,ip,#${R};bxls lr;sub r1,r1,#11;b #${STYLE_TO_RAW + 4};`);
  p.patch(STYLE_TO_RAW, 0xe241100b, branchWord(STYLE_TO_RAW, toRaw), 'films as looks: RAW development number of a film');
  const toStyle = p.code(`sub ip,r1,#${R};cmp ip,#${n - 1};addls r0,ip,#${FIRST};bxls lr;mov ip,sp;b #${RAW_TO_STYLE + 4};`);
  p.patch(RAW_TO_STYLE, 0xe1a0c00d, branchWord(RAW_TO_STYLE, toStyle), 'films as looks: the film of a RAW development number');
  // Row picks: a film's row is Bleach Bypass's.
  const map = (r: string) => `sub ${r},${r},#${R};cmp ${r},#${n};movlo ${r},#${RAW_BLEACH};addhs ${r},${r},#${R}`;
  const rows: number[] = [];
  for (let at = RAW_MODEL[0]; at < RAW_MODEL[1]; at += 4) if (p.u32(at) === RAW_ROW_LOAD) {
    if (p.u32(at + 4) !== 0xe3520000) fail(`RAW row pick at ${at.toString(16)}`);
    rows.push(at);
  }
  if (rows.length !== RAW_ROW_SITES) fail(`${rows.length} RAW row picks, expected ${RAW_ROW_SITES}`);
  const rowStubs = rows.map(at => {
    const stub = p.code(`ldrb r2,[r3,#0x83];${map('r2')};b #${at + 4};`);
    p.patch(at, RAW_ROW_LOAD, branchWord(at, stub), 'films as looks: RAW development row of Bleach Bypass');
    return stub;
  });
  if (p.u32(RAW_ROW_R1_SITE) !== RAW_ROW_LOAD_R1 || p.u32(RAW_ROW_R1_SITE + 4) !== 0xe3510000) fail('RAW row pick (r1)');
  const rowR1 = p.code(`ldrb r1,[r3,#0x83];${map('r1')};b #${RAW_ROW_R1_SITE + 4};`);
  p.patch(RAW_ROW_R1_SITE, RAW_ROW_LOAD_R1, branchWord(RAW_ROW_R1_SITE, rowR1), 'films as looks: RAW development row of Bleach Bypass');
  // The films' own values in that row.
  if (p.u32(RAW_FILL) !== 0xe5d4204c || p.u32(RAW_FILL - 4) !== bl(RAW_FILL - 4, 0x53288e40)) fail('RAW development fill');
  const fill = p.code(`push {r0-r3,ip,lr};mov r0,r4;bl #${sym.sp_raw_init};pop {r0-r3,ip,lr};ldrb r2,[r4,#0x4c];b #${RAW_FILL + 4};`);
  p.patch(RAW_FILL, 0xe5d4204c, branchWord(RAW_FILL, fill), 'films: their own RAW development parameters');
  if (p.u32(RAW_AS_SHOT) !== 0xe3500000 || p.u32(RAW_AS_SHOT - 4) !== bl(RAW_AS_SHOT - 4, STYLE_TO_RAW)) fail('RAW development as shot');
  const asShot = p.code(`push {r0-r3,ip,lr};mov r2,r0;mov r1,#0;mov r0,r4;bl #${sym.sp_raw_own};pop {r0-r3,ip,lr};${map('r0')};cmp r0,#0;b #${RAW_AS_SHOT + 4};`);
  p.patch(RAW_AS_SHOT, 0xe3500000, branchWord(RAW_AS_SHOT, asShot), 'films: RAW development parameters as shot');
  if (p.u32(RAW_APPLY) !== 0xe1a0c00d) fail('RAW development apply');
  const apply = p.code(`push {r0-r4,lr};bl #${sym.sp_raw_sync};pop {r0-r4,lr};mov ip,sp;b #${RAW_APPLY + 4};`);
  p.patch(RAW_APPLY, 0xe1a0c00d, branchWord(RAW_APPLY, apply), 'films: their own RAW development parameters');
  // The parameter screen: a film shows Standard's lines.
  if (p.u32(RAW_COLUMN) !== 0xe241100b) fail('RAW development parameter lines');
  const column = p.code(`sub ip,r1,#${FIRST};cmp ip,#${n - 1};movls r1,#${STANDARD};sub r1,r1,#11;b #${RAW_COLUMN + 4};`);
  p.patch(RAW_COLUMN, 0xe241100b, branchWord(RAW_COLUMN, column), 'films as looks: RAW development parameter lines of Standard');
  // The Image Control list: as shot (when offered), the looks, Custom 1 and 2.
  const looks = o.order.map(id => id >= FIRST ? R + id - FIRST : RAW_OF_STYLE[id]);
  if (looks.some(v => v === undefined) || new Set(looks).size !== looks.length) fail('RAW development list');
  const L = looks.length;
  const guards: readonly (readonly [number, number])[] = [[RAW_COUNT, 0xe5d03005], [RAW_COUNT + 8, 0x13a0000f], [RAW_COUNT + 12, 0x03a0000e],
    [RAW_BASE, 0xe5d03005], [RAW_LOOK, 0xe1a0c00d], [RAW_LOOK + 4, movWord(3, 0xacb4)], [RAW_CAPACITY, 0xe3a0000f], [RAW_CAPACITY + 4, 0xe12fff1e]];
  for (const [at, w] of guards) if (p.u32(at) !== w >>> 0) fail(`RAW development list at ${at.toString(16)}`);
  const table = p.append(Uint8Array.from(looks));
  const count = p.code(`ldrb r3,[r0,#5];cmp r3,#0;movne r0,#${L + 3};moveq r0,#${L + 2};bx lr;`);
  p.patch(RAW_COUNT, 0xe5d03005, branchWord(RAW_COUNT, count), 'films as looks: RAW development list length');
  // Entry i -> base: 0 for as shot and the looks, 1 / 2 for Custom 1 / 2.
  const base = p.code(`ldrb r3,[r0,#5];cmp r3,#0;addne r1,r1,#0;addeq r1,r1,#1;sub r1,r1,#${L + 1};cmp r1,#1;movhi r0,#0;addls r0,r1,#1;bx lr;`);
  p.patch(RAW_BASE, 0xe5d03005, branchWord(RAW_BASE, base), 'films as looks: RAW development list base');
  // Entry i -> RAW look: as shot 0, the looks from the table, Custom 1 / 2 the base's look.
  const look = p.code(`ldrb ip,[r0,#5];cmp ip,#0;beq lnoshot;cmp r1,#0;moveq r0,#0;bxeq lr;sub r1,r1,#1;
    lnoshot:cmp r1,#${L};bhs lcustom;${addr('ip', table)}ldrb r0,[ip,r1];bx lr;
    lcustom:sub r1,r1,#${L - 1};cmp r1,#2;movhi r1,#1;add r0,r0,r1;ldrb r0,[r0,#0x83];bx lr;`);
  p.patch(RAW_LOOK, 0xe1a0c00d, branchWord(RAW_LOOK, look), 'films as looks: RAW development list look');
  if (L + 3 > 17) p.patch(RAW_CAPACITY, 0xe3a0000f, (0xe3a00000 | (L + 3)) >>> 0, 'films as looks: RAW development list capacity');
  return { rawToRaw: toRaw, rawToStyle: toStyle, rawRows: rowStubs, rawRowR1: rowR1, rawFill: fill, rawAsShot: asShot, rawApply: apply,
    rawColumn: column, rawList: table, rawCount: count, rawBase: base, rawLook: look };
}

// ------------------------------------------------------------------ the picture's information
const TONE_WRITER = 0x535c780c, NOTE_STORE = 0x535d02c8;
export const GR3X_FILM_TONE_CODE = 0x8110;
const RAW_RECORD = 0x535bf7c4, PLAY_NUMBER = 0x535c2508, PLAY_STYLE = 0x532b44dc, PLAY_PARAMS = 0x532b7d10, PLAY_ICON = 0x532b6f3c;
const LIST_ASSIGN = 0x535c3ed8, LISTS = [0x535ca050, 0x535ca310] as const, LIST_CALLS = 17, LISTS_WITH_BLEACH = 7;
const TONING_WRITER = 0x535c5e34, TONING_READER = 0x535c0d04;

export function installGr3xR10PictureInfo(p: Gr3xR10Program, films: number, firstIcon: number) {
  const n = films;
  if (p.u32(TONE_WRITER) !== movWord(3, 0xad6c) || p.u32(NOTE_STORE) !== 0xe5903010) fail('maker note look');
  const writer = p.code(`ldrb ip,[r2,#0x77c];sub ip,ip,#${FIRST};cmp ip,#${n - 1};bhi native;mov r0,r1;mov r1,#0;movw r2,#${GR3X_FILM_TONE_CODE};add r2,r2,ip;b #${NOTE_STORE};
    native:movw r3,#0xad6c;b #${TONE_WRITER + 4};`);
  p.patch(TONE_WRITER, movWord(3, 0xad6c), branchWord(TONE_WRITER, writer), 'films as looks: the maker note\'s look code of a film');
  // Parameter lists: the looks a parameter is written as absent for; the films join Bleach Bypass's.
  const calls: number[] = [];
  for (let at = LISTS[0]; at < LISTS[1]; at += 4) {
    const w = p.u32(at);
    if (w === bl(at, LIST_ASSIGN) || w === branchWord(at, LIST_ASSIGN)) calls.push(at);
  }
  if (calls.length !== LIST_CALLS) fail(`maker note parameter lists: ${calls.length}`);
  const grown: number[] = [];
  for (const call of calls) {
    let low = 0, high = 0, add = 0;
    for (let k = 1; k < 14; k++) {
      const at = call - 4 * k, w = p.u32(at);
      if (!low && ((w & 0xfff0f000) >>> 0) === 0xe3001000) low = at;
      if (!high && ((w & 0xfff0f000) >>> 0) === 0xe3401000) high = at;
      if (!add && ((w & 0xfffff000) >>> 0) === 0xe2812000) add = at;
    }
    if (!low || !high || !add || (p.u32(add) & 0xf00) !== 0) fail(`maker note parameter list at ${call.toString(16)}`);
    const imm = (w: number) => ((w >>> 4) & 0xf000) | (w & 0xfff);
    const list = (imm(p.u32(low)) | imm(p.u32(high)) << 16) >>> 0, length = p.u32(add) & 0xff;
    const looks = p.read(list, length);
    if ([...looks].some(v => v >= FIRST)) fail('maker note list already has films');
    if (!looks.includes(GR3X_BLEACH)) continue;
    const bigger = Uint8Array.from([...looks, ...Array.from({ length: n }, (_, k) => FIRST + k)]);
    const at = p.append(bigger);
    p.patch(low, p.u32(low), movWord(1, lo(at)), 'films as looks: maker note parameters of Bleach Bypass');
    p.patch(high, p.u32(high), movWord(1, hi(at), true), 'films as looks: maker note parameters of Bleach Bypass');
    p.patch(add, p.u32(add), (0xe2812000 | bigger.length) >>> 0, 'films as looks: maker note parameters of Bleach Bypass');
    grown.push(at);
  }
  if (grown.length !== LISTS_WITH_BLEACH) fail(`maker note lists with Bleach Bypass: ${grown.length}`);
  // Bleach Bypass's Toning: a film's Halation state s as code 0x100 + s, and back.
  if (p.u32(TONING_WRITER) !== movWord(3, 0x7ad8) || p.u32(TONING_READER) !== movWord(3, 0xad90)) fail('maker note Toning');
  const toningWriter = p.code(`ldrb ip,[r1,#0x77c];sub ip,ip,#${FIRST};cmp ip,#${n - 1};bhi native;ldrb r0,[r1,#0x786];cmp r0,#11;movhi r0,#0;add r0,r0,#0x100;bx lr;
    native:movw r3,#0x7ad8;b #${TONING_WRITER + 4};`);
  p.patch(TONING_WRITER, movWord(3, 0x7ad8), branchWord(TONING_WRITER, toningWriter), 'films: the maker note\'s Toning holds the Halation');
  const toningReader = p.code(`sub ip,r1,#0x100;cmp ip,#11;strbls ip,[r2,#0x786];bxls lr;movw r3,#0xad90;b #${TONING_READER + 4};`);
  p.patch(TONING_READER, movWord(3, 0xad90), branchWord(TONING_READER, toningReader), 'films: the Halation back from the maker note');
  // Readers of the look code.
  const codeOf = (r: string) => `sub ${r},r0,#${GR3X_FILM_TONE_CODE & 0xff00};sub ${r},${r},#${GR3X_FILM_TONE_CODE & 0xff};cmp ${r},#${n - 1};`;
  if (p.u32(RAW_RECORD) !== 0xe2400c01 || p.u32(PLAY_NUMBER) !== 0xe2400c01 || p.u32(PLAY_STYLE) !== 0xe350000b || p.u32(PLAY_PARAMS) !== 0xe352000e || p.u32(PLAY_ICON) !== 0xe353000e) fail('picture information readers');
  const rawRecord = p.code(`${codeOf('r3')}bhi native;add r3,r3,#${FIRST};strb r3,[r4,#0x77c];b #${RAW_RECORD + 0x24};native:sub r0,r0,#0x100;b #${RAW_RECORD + 4};`);
  if (p.u32(RAW_RECORD + 0x24) !== 0xe89da818) fail('RAW record reader tail');
  p.patch(RAW_RECORD, 0xe2400c01, branchWord(RAW_RECORD, rawRecord), 'films as looks: the look of a RAW file');
  if (p.u32(PLAY_NUMBER + 0x20) !== 0xe1a00004) fail('playback number tail');
  const playNumber = p.code(`${codeOf('r3')}bhi native;add r2,r3,#${GR3X_RAW_FIRST_FILM};mov r1,#0x25;b #${PLAY_NUMBER + 0x20};native:sub r0,r0,#0x100;b #${PLAY_NUMBER + 4};`);
  p.patch(PLAY_NUMBER, 0xe2400c01, branchWord(PLAY_NUMBER, playNumber), 'films as looks: playback number of a film');
  const playStyle = p.code(`sub r3,r0,#${GR3X_RAW_FIRST_FILM - 1};cmp r3,#${n - 1};bhi native;cmp r4,#0;beq #${PLAY_STYLE + 0x30};add r3,r3,#${FIRST};strb r3,[r4];b #${PLAY_STYLE + 0x20};
    native:cmp r0,#0xb;b #${PLAY_STYLE + 4};`);
  p.patch(PLAY_STYLE, 0xe350000b, branchWord(PLAY_STYLE, playStyle), 'films as looks: playback style of a film');
  const playParams = p.code(`sub ip,r2,#${FIRST - 8};cmp ip,#${n - 1};movls r2,#${STANDARD - 8};cmp r2,#0xe;b #${PLAY_PARAMS + 4};`);
  p.patch(PLAY_PARAMS, 0xe352000e, branchWord(PLAY_PARAMS, playParams), 'films as looks: playback parameters of a film as Standard\'s');
  if (p.u32(PLAY_ICON + 0x18) !== 0xe51b2018) fail('playback icon tail');
  const playIcon = p.code(`sub r2,r3,#${FIRST - 8};cmp r2,#${n - 1};bhi native;movw r0,#${firstIcon};add r0,r0,r2;b #${PLAY_ICON + 0x18};native:cmp r3,#0xe;b #${PLAY_ICON + 4};`);
  p.patch(PLAY_ICON, 0xe353000e, branchWord(PLAY_ICON, playIcon), 'films as looks: playback icon of a film');
  return { toneWriter: writer, noteLists: grown, toningWriter, toningReader, rawRecord, playNumber, playStyle, playParams, playIcon };
}
