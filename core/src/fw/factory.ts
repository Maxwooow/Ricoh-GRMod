/**
 * The two card files that make the camera open its factory menu, read out of the user's own
 * firmware (GR IV 1.11). Nothing here is a stored copy of those files: the names, the keyword
 * and the key are located in the decoded firmware and cross-checked against each other.
 *
 * How the camera uses them (static analysis of 1.11, addresses are run-time addresses):
 *  - 0x538f28bc builds "C:\%08ld.%03ld" from SystemConfig's original product and project
 *    numbers (the "mode set" file) and requires that file to exist;
 *  - the same function decodes a second file name with XOR 0x29 ("C:\DEVELOP.MOD"), reads it,
 *    and 0x538f41b0 compares its 10 bytes with a key stored in the firmware;
 *  - 0x538f3544 scans the mode-set file line by line (lines end in CR LF, "!" and ";" start a
 *    comment) for keywords in square brackets and looks them up in a table of 33-byte records
 *    (32 bytes of text, 1 flag byte; a set flag asks for an extra authorisation).
 */
import { FirmwareError } from './types';
import { foff } from './profile';

/** 10 bytes compared with the content of the key file. */
const KEY_VA = 0x53fe59a8;
const KEY_LENGTH = 10;
/** Key file name, 15 bytes XOR 0x29. */
const KEY_NAME_VA = 0x53b4d60c;
const KEY_NAME_XOR = 0x29;
/** printf format of the mode-set file name. */
const MODESET_FORMAT_VA = 0x53fe4328;
const MODESET_FORMAT = 'C:\\%08ld.%03ld';
/** Per-model configuration records: original project number at +0x10, original product number at +0x14. */
const MODEL_RECORD_VAS = [0x53fe50d0, 0x53fe5180, 0x53fe5220] as const;
/** Keyword table of the mode-set file (in initialised RAM). */
const KEYWORD_TABLE_VA = 0x5501a474;
const KEYWORD_RECORD = 0x21;
const KEYWORD_MAX = 64;
const OPEN_FACTORY_MENU = 'OPEN_FACTORY_DEBUG_MENU';

export interface FactoryEntry {
  /** Files for the card root, in the order they should be written. */
  files: { name: string; data: Uint8Array }[];
  /** Name of the mode-set file, e.g. `00078560.636`. */
  modeSetName: string;
  /** Name of the key file. */
  keyName: string;
}

function ascii(d: Uint8Array, o: number, max: number): string {
  let s = '';
  for (let i = 0; i < max && d[o + i] !== 0; i++) s += String.fromCharCode(d[o + i]);
  return s;
}
const u32 = (d: Uint8Array, o: number): number => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const bad = (what: string): never => {
  throw new FirmwareError('unexpected-layout', `factory entry: ${what}`);
};

/** Keywords the mode-set file may contain, with their authorisation flag. */
export function modeSetKeywords(decoded: Uint8Array): { keyword: string; restricted: boolean }[] {
  const out: { keyword: string; restricted: boolean }[] = [];
  const base = foff(KEYWORD_TABLE_VA);
  for (let i = 0; i < KEYWORD_MAX; i++) {
    const o = base + i * KEYWORD_RECORD;
    const keyword = ascii(decoded, o, 0x20);
    if (!/^[A-Z][A-Z0-9_ ]{2,30}$/.test(keyword)) break;
    out.push({ keyword, restricted: decoded[o + 0x20] !== 0 });
  }
  return out;
}

/** Locate and cross-check everything the factory-menu entry needs. Throws when anything is off. */
export function readFactoryEntry(decoded: Uint8Array): FactoryEntry {
  if (ascii(decoded, foff(MODESET_FORMAT_VA), 32) !== MODESET_FORMAT) bad('file name format not found');

  const numbers = MODEL_RECORD_VAS.map((va) => ({ project: u32(decoded, foff(va) + 0x10), product: u32(decoded, foff(va) + 0x14) }));
  const { project, product } = numbers[0];
  if (numbers.some((n) => n.project !== project || n.product !== product)) bad('models disagree on the file name');
  if (!(project > 0 && project < 1000 && product > 0 && product < 100_000_000)) bad('implausible product numbers');
  const modeSetName = `${String(product).padStart(8, '0')}.${String(project).padStart(3, '0')}`;

  let keyPath = '';
  const kn = foff(KEY_NAME_VA);
  for (let i = 0; i < 15; i++) {
    const c = decoded[kn + i] ^ KEY_NAME_XOR;
    if (c === 0) break;
    keyPath += String.fromCharCode(c);
  }
  const m = /^C:\\([A-Z0-9]{1,8}\.[A-Z0-9]{1,3})$/.exec(keyPath);
  if (!m) bad('key file name not found');
  const keyName = m![1];

  const key = decoded.slice(foff(KEY_VA), foff(KEY_VA) + KEY_LENGTH);
  if (key.every((b) => b === 0) || key.every((b) => b === 0xff)) bad('key not found');

  const kw = modeSetKeywords(decoded).find((k) => k.keyword === OPEN_FACTORY_MENU);
  if (!kw) bad('keyword not found');
  if (kw!.restricted) bad('keyword needs an authorisation this tool does not have');

  const text = `[${OPEN_FACTORY_MENU}]\r\n`;
  const modeSet = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) modeSet[i] = text.charCodeAt(i);
  return { files: [{ name: keyName, data: key }, { name: modeSetName, data: modeSet }], modeSetName, keyName };
}
