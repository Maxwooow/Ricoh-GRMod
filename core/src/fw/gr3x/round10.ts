// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60, round 10: the GR IV ways of GR Mod's additions (../aspect/*.ts), where
 * GR III has the same structures. What is shared by several of them is here.
 *
 * RAM words (GR IV: the 44 zero-filled bytes before its heap, one word per addition). The start-up
 * zero fill (0x530003ac, its end the literal at 0x53000460) stops at 0x55804374; after it come 12
 * bytes of alignment and then newlib's `end` (0x55804380) with its 64-byte sbrk area, which nothing
 * uses (the two sbrk copies, 0x5304f6bc and 0x53147ad8, are never called or referenced). The heap
 * that the firmware does use starts with a block header at 0x558043c0 (its set-up 0x53852338), and
 * operator new (0x536af2a8) has a pool of its own (0x59600000). The fill now ends at 0x558043c0:
 * 76 bytes, cleared at every start, one word per addition as on GR IV. Up to round 9 the fill
 * ended at 0x55804380 and three words were shared by packing bytes into them.
 *
 * Settings scaffold (GR IV: build.ts `initializeScaffold`, used by the slots' parameters, the
 * settings guard and the End Screen record). The settings load, UserDataModel::LoadData
 * (0x5324b284, called once, from the settings object's construction) and the settings save,
 * SaveData (0x5323f274, called once, a tail call of the power-off handler) start with `mov ip,sp`
 * and nothing branches to their second instruction. Their first word becomes a branch to a
 * continuation (`mov ip,sp; b entry + 4`); an addition hooks one by pointing the entry at its own
 * code, which calls whatever the entry pointed at before (the prior), as on GR IV. The load runs
 * while the settings object is being made: what is hooked there works from r0 (the object; its
 * record in use at +4) and never asks for the object (its getter 0x5320b31c).
 */
import { branchWord } from '../aspect/arm';
import { FirmwareError } from '../types';

export const GR3X_ZERO_FILL_LITERAL = 0x53000460;
/** End of the start-up zero fill: official, rounds 6..9, round 10. */
export const GR3X_FILL_OFFICIAL = 0x55804374;
export const GR3X_FILL_R9 = 0x55804380;
export const GR3X_FILL_R10 = 0x558043c0;

/** Round 10's words (GR IV's names, ../aspect/lookstash.ts, slots.ts, shutdown.ts). */
export const GR3X_R10 = {
  /** The films' state pointer (GR IV: SLOT_STATE, slot_params.c sp_gap[0]). */
  slotState: 0x55804374,
  /** The look of the picture being made: look | level << 8 | 0x10000 (| 0x20000 white), GR IV's LOOK_STASH. */
  lookStash: 0x55804378,
  /** The End Screen list's mode (GR IV: PICTURE_MODE). */
  pictureMode: 0x5580437c,
  /** The orientation of the picture being made: value | 0x100 (GR IV: ORIENT_WORD). */
  orientWord: 0x55804380,
  /** The look at the start of the exposure, LOOK_STASH's word (GR IV: FRAME_LOOK). */
  frameLook: 0x55804384,
  /** Reserved for the End Screen choice (unused: as GR IV's shutdown.c, endscreen.c reads its record each time). */
  endScreenChoice: 0x55804388,
} as const;

export const GR3X_SETTINGS_LOAD = 0x5324b284;
export const GR3X_SETTINGS_SAVE = 0x5323f274;

export interface Gr3xSite { address: number; expected: string; replacement: string; reason: string }
export interface Gr3xScaffoldProgram {
  code(source: string): number;
  sites: Gr3xSite[];
  u32(address: number): number;
}

const hexWord = (w: number) => Array.from([w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24], b => b.toString(16).padStart(2, '0')).join('');
const wordOf = (h: string) => (parseInt(h.slice(0, 2), 16) | parseInt(h.slice(2, 4), 16) << 8 | parseInt(h.slice(4, 6), 16) << 16 | parseInt(h.slice(6, 8), 16) << 24) >>> 0;
const fail = (m: string): never => { throw new FirmwareError('unexpected-instruction', `IIIx round 10: ${m}`); };

function branchTargetOf(at: number, w: number): number {
  if ((w & 0x0f000000) !== 0x0a000000) fail(`no branch at ${at.toString(16)}`);
  const off = (w & 0xffffff) << 8 >> 8;
  return (at + 8 + off * 4) >>> 0;
}

/** The scaffold: both entries go to a continuation of the native function. */
export function installGr3xSettingsScaffold(p: Gr3xScaffoldProgram) {
  const out: Record<string, number> = {};
  for (const [name, at] of [['settingsLoadNative', GR3X_SETTINGS_LOAD], ['settingsSaveNative', GR3X_SETTINGS_SAVE]] as const) {
    if (p.u32(at) !== 0xe1a0c00d || p.u32(at + 4) >>> 16 !== 0xe92d) fail('settings load / save entry');
    if (p.sites.some(s => s.address === at)) fail('settings entry already patched');
    const cont = p.code(`mov ip,sp;b #${at + 4};`);
    p.sites.push({ address: at, expected: hexWord(0xe1a0c00d), replacement: hexWord(branchWord(at, cont)), reason: 'settings scaffold: continuation of the native settings load / save' });
    out[name] = cont;
  }
  return out;
}

/** What the entry runs now (the prior an addition calls). */
export function gr3xSettingsPrior(p: Pick<Gr3xScaffoldProgram, 'sites'>, which: 'load' | 'save'): number {
  const at = which === 'load' ? GR3X_SETTINGS_LOAD : GR3X_SETTINGS_SAVE;
  const site = p.sites.find(s => s.address === at);
  if (!site) fail('the settings scaffold is not installed');
  return branchTargetOf(at, wordOf(site!.replacement));
}

/** Point the entry at `target` (which calls the prior itself). */
export function gr3xSettingsHook(p: Pick<Gr3xScaffoldProgram, 'sites'>, which: 'load' | 'save', target: number, reason: string) {
  const at = which === 'load' ? GR3X_SETTINGS_LOAD : GR3X_SETTINGS_SAVE;
  const site = p.sites.find(s => s.address === at);
  if (!site) fail('the settings scaffold is not installed');
  site!.replacement = hexWord(branchWord(at, target));
  site!.reason = reason;
}
