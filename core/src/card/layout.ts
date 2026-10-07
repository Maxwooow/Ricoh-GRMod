/**
 * What goes where on the memory card. Pure planning: the caller lists the card, gets a list of
 * steps, and executes them through whatever file API the platform has.
 *
 * A card serves one purpose at a time, and every plan leaves it ready for exactly that purpose:
 *  - firmware card: `fwdc248b.bin` in the root and nothing that starts the camera's script engine
 *    or factory menu (`script\startup.ttl`, `00078560.636`, `DEVELOP.MOD`);
 *  - power-off image card: `script\startup.ttl`, `GBR<n>.JPG`, `GBRIDX.TXT`, no firmware file and
 *    no factory-menu entry files;
 *  - factory-menu card: the two entry files and no firmware file (holding MENU while switching
 *    on starts either the factory menu or the firmware update).
 * Files that are in the way are never deleted; they are moved into `GRMOD\parked-<stamp>\`.
 */
export const FIRMWARE_FILE = 'fwdc248b.bin';
export const SCRIPT_DIR = 'script';
export const SCRIPT_FILE = 'startup.ttl';
export const FACTORY_ENTRY_FILES = ['00078560.636', 'DEVELOP.MOD'] as const;
export const INDEX_FILE = 'GBRIDX.TXT';
export const PAUSE_FILE = 'GBRSTOP.TXT';
export const PARK_ROOT = 'GRMOD';

export interface CardEntry {
  name: string;
  dir: boolean;
  size: number;
}

export interface CardListing {
  /** Entries of the card's root directory. */
  root: CardEntry[];
  /** Entries of `script\` (empty when the directory does not exist). */
  script: CardEntry[];
}

export type CardRole = 'empty' | 'firmware' | 'wallpaper' | 'mixed' | 'other';

export type PlanStep =
  | { op: 'move'; from: string[]; to: string[] }
  | { op: 'write'; path: string[]; data: Uint8Array };

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const has = (list: CardEntry[], name: string, dir = false): boolean => list.some((e) => eq(e.name, name) && e.dir === dir);

export function cardRole(l: CardListing): CardRole {
  // The script is what makes a card act as a power-off image card; image files alone are inert.
  const fw = has(l.root, FIRMWARE_FILE);
  const script = has(l.script, SCRIPT_FILE);
  if (fw && script) return 'mixed';
  if (fw) return 'firmware';
  if (script) return 'wallpaper';
  return l.root.length === 0 ? 'empty' : 'other';
}

function parkDir(stamp: string): string[] {
  if (!/^[0-9A-Za-z_-]{1,32}$/.test(stamp)) throw new Error('bad stamp');
  return [PARK_ROOT, `parked-${stamp}`];
}

/** Moves for the factory-menu entry files that are on the card. */
function parkEntryFiles(l: CardListing, park: string[]): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const name of FACTORY_ENTRY_FILES) {
    const e = l.root.find((x) => !x.dir && eq(x.name, name));
    if (e) steps.push({ op: 'move', from: [e.name], to: [...park, e.name] });
  }
  return steps;
}

/** Steps to turn the card into a firmware card holding `firmware` as `fwdc248b.bin`. */
export function planFirmwareCard(l: CardListing, firmware: Uint8Array, stamp: string): PlanStep[] {
  const steps: PlanStep[] = [];
  const park = parkDir(stamp);
  for (const e of l.script) {
    if (!e.dir && eq(e.name, SCRIPT_FILE)) steps.push({ op: 'move', from: [SCRIPT_DIR, e.name], to: [...park, SCRIPT_DIR, e.name] });
  }
  steps.push(...parkEntryFiles(l, park));
  steps.push({ op: 'write', path: [FIRMWARE_FILE], data: firmware });
  return steps;
}

/** Steps to turn the card into a power-off image card. `images[i]` becomes `GBR<i+1>.JPG`. */
export function planWallpaperCard(l: CardListing, images: Uint8Array[], script: string, stamp: string): PlanStep[] {
  if (images.length < 1 || images.length > 9) throw new Error('1 to 9 images');
  if (!/^[\x09\x0a\x20-\x7e]*$/.test(script)) throw new Error('script must be ASCII');
  const steps: PlanStep[] = [];
  const park = parkDir(stamp);
  const fw = l.root.find((x) => !x.dir && eq(x.name, FIRMWARE_FILE));
  if (fw) steps.push({ op: 'move', from: [fw.name], to: [...park, fw.name] });
  const pause = l.root.find((x) => !x.dir && eq(x.name, PAUSE_FILE));
  if (pause) steps.push({ op: 'move', from: [pause.name], to: [...park, pause.name] });
  steps.push(...parkEntryFiles(l, park));
  images.forEach((data, i) => steps.push({ op: 'write', path: [`GBR${i + 1}.JPG`], data }));
  steps.push({ op: 'write', path: [INDEX_FILE], data: new Uint8Array([0x31]) });
  const bytes = new Uint8Array(script.length);
  for (let i = 0; i < script.length; i++) bytes[i] = script.charCodeAt(i);
  // the script goes last: until it is in place the camera keeps running whatever was there before
  steps.push({ op: 'write', path: [SCRIPT_DIR, SCRIPT_FILE], data: bytes });
  return steps;
}

/** The files a plan writes, for "export to folder" (no parking there). */
export function planFiles(steps: PlanStep[]): { path: string[]; data: Uint8Array }[] {
  return steps.filter((s): s is Extract<PlanStep, { op: 'write' }> => s.op === 'write').map((s) => ({ path: s.path, data: s.data }));
}

/** A power-off image setup as it was found on (or written to) a card. */
export interface WallpaperSnapshot {
  /** Text of `script\startup.ttl`, kept verbatim. */
  script: Uint8Array;
  /** Image files of the card root, e.g. `GBR1.JPG`. */
  images: { name: string; data: Uint8Array }[];
  /** Content of `GBRIDX.TXT` when the snapshot was taken, if any. */
  index?: Uint8Array;
}

const IMAGE_NAME = /^GBR[1-9]\.JPG$/i;

/** Names of the rotation images present in the card root. */
export function wallpaperImageNames(l: CardListing): string[] {
  return l.root.filter((e) => !e.dir && IMAGE_NAME.test(e.name)).map((e) => e.name).sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase()));
}

/** True when the card currently runs a power-off image script. */
export function hasWallpaperScript(l: CardListing): boolean {
  return has(l.script, SCRIPT_FILE);
}

/**
 * Steps that put a remembered power-off image setup back on a card: the firmware file and a pause
 * file are moved aside, the images and the script are written exactly as remembered, and the
 * rotation index on the card is kept when there is one.
 */
export function planRestoreWallpaper(l: CardListing, snap: WallpaperSnapshot, stamp: string): PlanStep[] {
  if (snap.images.length < 1 || snap.images.length > 9) throw new Error('1 to 9 images');
  for (const im of snap.images) if (!IMAGE_NAME.test(im.name)) throw new Error(`unexpected image name ${im.name}`);
  if (snap.script.length === 0) throw new Error('empty script');
  const steps: PlanStep[] = [];
  const park = parkDir(stamp);
  for (const name of [FIRMWARE_FILE, PAUSE_FILE]) {
    const e = l.root.find((x) => !x.dir && eq(x.name, name));
    if (e) steps.push({ op: 'move', from: [e.name], to: [...park, e.name] });
  }
  steps.push(...parkEntryFiles(l, park));
  for (const im of snap.images) {
    // reuse the spelling of a file that is already there (matters on a case-sensitive file system)
    const present = l.root.find((x) => !x.dir && eq(x.name, im.name));
    steps.push({ op: 'write', path: [present ? present.name : im.name.toUpperCase()], data: im.data });
  }
  if (!has(l.root, INDEX_FILE)) steps.push({ op: 'write', path: [INDEX_FILE], data: snap.index && snap.index.length === 1 ? snap.index : new Uint8Array([0x31]) });
  steps.push({ op: 'write', path: [SCRIPT_DIR, SCRIPT_FILE], data: snap.script });
  return steps;
}

// ---------------------------------------------------------------- factory-menu entry

/** True when the card root holds every one of `names` (the files that open the factory menu). */
export function hasEntryFiles(l: CardListing, names: readonly string[] = FACTORY_ENTRY_FILES): boolean {
  return names.length > 0 && names.every((n) => has(l.root, n));
}

/**
 * Steps that put the factory-menu entry files in the card root. The firmware file is moved aside:
 * the factory menu and the firmware update are both started by holding MENU while switching on.
 */
export function planEntryCard(l: CardListing, files: { name: string; data: Uint8Array }[], stamp: string): PlanStep[] {
  if (files.length === 0) throw new Error('no entry files');
  for (const f of files) if (!/^[A-Z0-9]{1,8}\.[A-Z0-9]{1,3}$/.test(f.name) || f.data.length === 0 || f.data.length > 4096) throw new Error(`unexpected entry file ${f.name}`);
  const steps: PlanStep[] = [];
  const fw = l.root.find((x) => !x.dir && eq(x.name, FIRMWARE_FILE));
  if (fw) steps.push({ op: 'move', from: [fw.name], to: [...parkDir(stamp), fw.name] });
  for (const f of files) {
    const present = l.root.find((x) => !x.dir && eq(x.name, f.name));
    steps.push({ op: 'write', path: [present ? present.name : f.name], data: f.data });
  }
  return steps;
}
