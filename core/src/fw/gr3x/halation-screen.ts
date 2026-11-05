// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60, round 6: a film's "Halation" line on the camera's Image Control
 * parameter screen (ImageControlDetailController), as GR IV's added slots have it (there it is
 * Cinema's Toning). GR III has no look with a spare parameter that Standard's development ignores
 * and that stores per look, so the line is HDR Tone's Toning (parameter kind 10: a three-position
 * slider 0..2, text 0x12f) shown for a film, and its value is kept outside the camera's settings:
 * per film and photo set in the own-parameters table (native/slots2.c, HTData record 12). Nothing
 * of HDR Tone's own Toning changes: for a film no native Toning getter or setter is called.
 *
 * What the screen does, read from the official 2.10 code:
 *  - The controller keeps the photo set (+0x199, 0..2), the look being edited (+0x198: a film's
 *    own id 64.., from 0x532bd6b4) and a base column (+0x19a) from GetBaseKindDetailControl
 *    (0x531aca98), which maps looks 11..22 to 0..11; any other look takes its default case (an
 *    assert that only logs, then column 0: Standard's lines, as T6).
 *  - The lines of a column come from a table of 36 {list, count} (0x53b3488c), indexed
 *    12 * set + column; a list holds {valid, kind} pairs (valid 2 always, 0 stills only). Four
 *    functions read the table (movw/movt pairs at 0x531afa20, 0x531afabc, 0x531affa0,
 *    0x531b01f4); every read of +0x19a in the controller passes it to them.
 *
 * Changed:
 *  - The table is copied with three more entries (36 + set): Standard's lines of set 0 (and of
 *    sets 1/2, which start with the base look line 17) followed by (stills only, kind 10).
 *  - GetBaseKindDetailControl's default case: for a film of this build (look 64..63+n) and a
 *    photo set 0..2 the column 36 - 11 * set (so that 12 * set + column = 36 + set); any other
 *    look goes on to the official default case.
 *  - For a film, kind 10's name (subtitle, 0x531b0254) is "Halation", its list icon (0x531af4a8)
 *    and slider scale (0x531adcbc) GR IV's halation pictures, its list text (0x531af494) "--" /
 *    "W" / "S" (sp_hal_text), the slider's start (0x531adca0) and current position (0x531b0514)
 *    the stored level (sp_hal), and moving the slider (0x531b0d8c, OnChangeSliderViewValueIndex's
 *    kind 10) stores the level (sp_hal_put) instead of calling SetColorToneHdrIntense.
 *  - The screen's backup of the parameters when it opens (0x532c337c, called only by this screen,
 *    0x531b1060 / 0x531b10c8) and their restore on Cancel (0x532c34a8, 0x531acd14 / 0x531b0b30) also
 *    keep and put back the levels (sp_hal_backup / sp_hal_restore).
 * The development step leaves the level of the frame's film for the JPEG's halation (image-control.ts,
 * sp_hal_level).
 */
import { branchWord, movWord } from '../aspect/arm';
import { FirmwareError } from '../types';

/** GR III's own three-position scale of HDR Tone's Toning (400 x 60). */
export const GR3X_TONING_SCALE = 0xd3;
const FIRST = 64;
const TABLE = 0x53b3488c, ENTRIES = 36, KIND_TONING = 10;
const TABLE_SITES: readonly (readonly [number, number, number])[] = [
  [0x531afa20, 0x531afa24, 12], [0x531afabc, 0x531afacc, 3], [0x531affa0, 0x531affa8, 12], [0x531b01f4, 0x531b01f8, 3],
];
const BASE_DEFAULT = 0x531acb24, BASE_DEFAULT_TARGET = 0x531acbbc, BASE_RETURN = 0x531acb5c;
const SUBTITLE = 0x531b0254, SCALE = 0x531adcbc, START = 0x531adca0, POSITION = 0x531b0514;
const LIST_TEXT = 0x531af494, LIST_ICON = 0x531af4a8, SETTER = 0x531b0d8c;
const STORED_GETTER = 0x532c70e4, LIVE_GETTER = 0x532c297c, TEXT_OF_VALUE = 0x532aca68, HDR_SETTER = 0x532c0894;
const TONING_ICON = 0x1e9, TONING_TEXT = 0x12f;
const BACKUP = 0x532c337c, BACKUP_BODY = 0x532c325c, RESTORE = 0x532c34a8, RESTORE_BODY = 0x532c33c8;

export interface Gr3xHalationScreenProgram {
  code(source: string): number;
  append(bytes: Uint8Array): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  u32(address: number): number;
  read(address: number, size: number): Uint8Array;
}
export interface Gr3xHalationScreenOptions {
  films: number; textId: number; iconId: number; scaleIconId: number;
  /** slots2.c: sp_hal(look, set), sp_hal_put(look, set, value), sp_hal_text(look, set, text),
   * sp_hal_backup(), sp_hal_restore(). */
  hal: number; put: number; text: number; backup: number; restore: number;
}

const bl = (at: number, target: number) => (0xeb000000 | (((target - (at + 8)) >> 2) & 0xffffff)) >>> 0;
const fail = (m: string): never => { throw new FirmwareError('unexpected-instruction', `IIIx halation screen: ${m}`); };

export function installGr3xHalationScreen(p: Gr3xHalationScreenProgram, o: Gr3xHalationScreenOptions) {
  const n = o.films;
  if (!Number.isInteger(n) || n < 1 || n > 20) fail('number of films');
  // `film(r, ctl)`: flags "ls" when the controller's look is a film of this build (r clobbered).
  const film = (r: string, ctl: string) => `ldrb ${r},[${ctl},#0x198];sub ${r},${r},#${FIRST};cmp ${r},#${n - 1};`;
  const guards: readonly (readonly [number, number])[] = [
    [BASE_DEFAULT, 0xea000024], [BASE_DEFAULT - 8, 0xe354000b], [BASE_RETURN, 0xe24bd018],
    [SUBTITLE, 0xe1d310b2], [SUBTITLE - 0x14, 0xe3520001],
    [SCALE, 0xe3a030d3], [START, bl(START, STORED_GETTER)], [POSITION, bl(POSITION, LIVE_GETTER)],
    [LIST_TEXT, bl(LIST_TEXT, TEXT_OF_VALUE)], [LIST_ICON, 0xe30011e9], [SETTER, bl(SETTER, HDR_SETTER)],
    [SETTER - 0xc, 0xe30e3bc4], [SETTER - 8, 0xe34533b4], [SETTER - 4, 0xe7d31006],
    // The registers the hooks read: the controller in r6 (start, scale, list), r5 (position),
    // r4 (subtitle, setter), as the surrounding official code has it.
    [START - 0x18, 0xe1a06000], [POSITION - 0x138, 0xe1a05000], [LIST_TEXT - 0x18, 0xe1a06000], [SUBTITLE - 0x38, 0xe1a04000],
    [0x531b0bbc, 0xe1a04000],
  ];
  for (const [at, w] of guards) if (p.u32(at) !== w >>> 0) fail(`guard at ${at.toString(16)}`);
  // --- The table with the three Halation lists.
  for (const [lo, hi, r] of TABLE_SITES)
    if (p.u32(lo) !== movWord(r, TABLE & 0xffff) || p.u32(hi) !== movWord(r, TABLE >>> 16, true)) fail('table site');
  const official = p.read(TABLE, ENTRIES * 8), ov = new DataView(official.buffer);
  const list = (entry: number) => {
    const at = ov.getUint32(entry * 8, true), count = ov.getUint32(entry * 8 + 4, true);
    const items = p.read(at, count * 2);
    for (let k = 0; k < count; k++) if (items[2 * k + 1] === KIND_TONING) fail('Standard already has kind 10');
    return Uint8Array.from([...items, 0, KIND_TONING]);
  };
  const set0 = list(0), set12 = list(12);
  // Standard's lines: set 0 9 lines (no base-look line), sets 1/2 the same list with line 17 first.
  if (set0.length !== 20 || set12.length !== 22 || set12[1] !== 17 || ov.getUint32(12 * 8, true) !== ov.getUint32(24 * 8, true)) fail('Standard lines');
  const l0 = p.append(set0), l12 = p.append(set12);
  const extra = new Uint8Array(24), ev = new DataView(extra.buffer);
  [[l0, set0.length / 2], [l12, set12.length / 2], [l12, set12.length / 2]].forEach(([a, c], k) => { ev.setUint32(k * 8, a, true); ev.setUint32(k * 8 + 4, c, true); });
  const table = p.append(Uint8Array.from([...official, ...extra]));
  for (const [lo, hi, r] of TABLE_SITES) {
    p.patch(lo, movWord(r, TABLE & 0xffff), movWord(r, table & 0xffff), 'halation: parameter lines with Halation, low half');
    p.patch(hi, movWord(r, TABLE >>> 16, true), movWord(r, table >>> 16, true), 'halation: parameter lines with Halation, high half');
  }
  // --- Base column (r4 = look - 11, r6 = controller; r0 the result, r1 free).
  const base = p.code(`sub r0,r4,#${FIRST - 11};cmp r0,#${n - 1};bhi native;ldrb r0,[r6,#0x199];cmp r0,#2;bhi native;
    cmp r0,#1;moveq r0,#25;movhi r0,#14;movlo r0,#36;b #${BASE_RETURN};native:b #${BASE_DEFAULT_TARGET};`);
  p.patch(BASE_DEFAULT, 0xea000024, branchWord(BASE_DEFAULT, base), 'halation: a film\'s parameter lines');
  // --- Name (r0 the kind, r3 the text table entry, r4 the controller).
  const subtitle = p.code(`ldrh r1,[r3,#2];cmp r0,#${KIND_TONING};bne done;${film('ip', 'r4')}movwls r1,#${o.textId};done:b #${SUBTITLE + 4};`);
  p.patch(SUBTITLE, 0xe1d310b2, branchWord(SUBTITLE, subtitle), 'halation: name of the line');
  // --- Slider scale (r6 the controller).
  const scale = p.code(`${film('r3', 'r6')}mov r3,#${GR3X_TONING_SCALE};movwls r3,#${o.scaleIconId};b #${SCALE + 4};`);
  p.patch(SCALE, 0xe3a030d3, branchWord(SCALE, scale), 'halation: slider scale');
  // --- Slider start and position: the stored level (calls: r0-r3, ip, lr free).
  const level = (at: number, ctl: string, native: number) => {
    const stub = p.code(`${film('r2', ctl)}bhi native;ldrb r0,[${ctl},#0x198];ldrb r1,[${ctl},#0x199];bl #${o.hal};b #${at + 4};
      native:bl #${native};b #${at + 4};`);
    p.patch(at, bl(at, native), bl(at, stub), 'halation: the stored level');
    return stub;
  };
  const start = level(START, 'r6', STORED_GETTER), position = level(POSITION, 'r5', LIVE_GETTER);
  // --- List line: value text (r1 the 3-byte buffer) and icon (r0, r2 kept).
  const listText = p.code(`${film('r2', 'r6')}bhi native;mov r2,r1;ldrb r0,[r6,#0x198];ldrb r1,[r6,#0x199];bl #${o.text};b #${LIST_TEXT + 4};
    native:bl #${TEXT_OF_VALUE};b #${LIST_TEXT + 4};`);
  p.patch(LIST_TEXT, bl(LIST_TEXT, TEXT_OF_VALUE), bl(LIST_TEXT, listText), 'halation: value of the line');
  const listIcon = p.code(`${film('r1', 'r6')}movw r1,#${TONING_ICON};movwls r1,#${o.iconId};b #${LIST_ICON + 4};`);
  p.patch(LIST_ICON, 0xe30011e9, branchWord(LIST_ICON, listIcon), 'halation: icon of the line');
  // --- Moving the slider (r1 the value, r4 the controller).
  const setter = p.code(`${film('r2', 'r4')}bhi native;mov r2,r1;ldrb r0,[r4,#0x198];ldrb r1,[r4,#0x199];bl #${o.put};b #${SETTER + 4};
    native:bl #${HDR_SETTER};b #${SETTER + 4};`);
  p.patch(SETTER, bl(SETTER, HDR_SETTER), bl(SETTER, setter), 'halation: store the level');
  // --- Cancel: the screen backs the parameters up when it opens (0x532c337c, a thunk to 0x532c325c)
  // and restores them on Cancel (0x532c34a8, a thunk to 0x532c33c8); the levels go with them.
  const thunk = (at: number, target: number, fn: number, what: string) => {
    if (p.u32(at) !== branchWord(at, target)) fail(`thunk at ${at.toString(16)}`);
    const stub = p.code(`push {r0-r3,ip,lr};bl #${fn};pop {r0-r3,ip,lr};b #${target};`);
    p.patch(at, branchWord(at, target), branchWord(at, stub), what);
    return stub;
  };
  const backup = thunk(BACKUP, BACKUP_BODY, o.backup, 'halation: kept when the parameter screen opens');
  const restore = thunk(RESTORE, RESTORE_BODY, o.restore, 'halation: put back on Cancel');
  void TONING_TEXT;
  return { table, lists: [l0, l12], base, subtitle, scale, start, position, listText, listIcon, setter, backup, restore };
}
