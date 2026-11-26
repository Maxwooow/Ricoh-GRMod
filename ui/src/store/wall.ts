import { SHUTDOWN_MAX_PICTURES, SHUTDOWN_NAME_MAX, validateShutdownName } from '@grmod/core';
import type { ShutdownPictureSpec } from '@grmod/core';
import { engine } from '../engine';
import { host } from '../host';
import { t } from '../i18n';
import type { Key } from '../i18n';
import { cropToRgb, defaultCrop, loadBitmap, workingCopy } from '../pixels';
import type { Crop } from '../pixels';
import { State, WallItem, fail, set, setWall, state, toast } from './core';
import { scheduleSave } from './families';
import { recordDeleted } from './undo';

// ------------------------------------------------------------------ power-off images
const wallBitmaps = new Map<string, ImageBitmap>();
export async function wallBitmap(w: WallItem): Promise<ImageBitmap | null> {
  if (!w.blob) return null;
  let b = wallBitmaps.get(w.id);
  if (!b) { b = await loadBitmap(w.blob); wallBitmaps.set(w.id, b); }
  return b;
}
const encodeGen = new Map<string, number>();
/** A picture of the firmware: the crop as it is, its own fixed size (see core aspect/shutdown.ts). */
export async function encodeWall(id: string): Promise<void> {
  const w = state.wall.find((x) => x.id === id);
  if (!w || !state.info) return;
  const gen = (encodeGen.get(id) || 0) + 1; encodeGen.set(id, gen);
  setWall(id, { busy: true, error: undefined });
  try {
    const bmp = await wallBitmap(w);
    if (!bmp) throw new Error('no image');
    const rgb = cropToRgb(bmp, w.crop);
    const jpeg = await engine.menuPicture(rgb);
    if (encodeGen.get(id) !== gen) return;
    setWall(id, { busy: false, menuJpeg: jpeg, preview: rgb, error: undefined });
  } catch {
    if (encodeGen.get(id) !== gen) return;
    setWall(id, { busy: false, menuJpeg: undefined, preview: undefined, error: t('encodeFailed') });
  }
}
/** At most this many images (the camera's menu lists them). */
export const wallMax = (): number => SHUTDOWN_MAX_PICTURES;
export async function addWallFiles(files: File[]): Promise<void> {
  for (const f of files) {
    if (state.wall.length >= wallMax()) { toast(t('wallMax', { n: wallMax() }), 'info'); break; }
    if (!/^image\//.test(f.type) && !/\.(jpe?g|png|webp|bmp|gif|avif|heic|heif)$/i.test(f.name)) continue;
    try {
      const bmp = await loadBitmap(f);
      const wc = await workingCopy(bmp);
      bmp.close();
      const id = Math.random().toString(36).slice(2, 10);
      const item: WallItem = { id, name: f.name, blob: wc.blob, width: wc.width, height: wc.height, crop: defaultCrop(wc.width, wc.height), busy: true, menuName: menuNameOf(f.name), menuId: newMenuId(state.wall) };
      set((s) => ({ wall: [...s.wall, item] }));
      if (host.available) void host.storeSet('wall-' + id, new Uint8Array(await wc.blob.arrayBuffer())).catch(() => undefined);
      void encodeWall(id);
    } catch (e) { fail(e); }
  }
  scheduleSave();
}
/** Take a power-off picture away; the toast's Undo brings it back (its host file is deleted when that window closes). */
export function removeWall(id: string): void {
  const index = state.wall.findIndex((w) => w.id === id), item = state.wall[index];
  set((s) => ({ wall: s.wall.filter((w) => w.id !== id) }));
  wallBitmaps.get(id)?.close(); wallBitmaps.delete(id);
  scheduleSave();
  const del = (): void => { if (host.available) void host.storeDel('wall-' + id).catch(() => undefined); };
  if (!item) { del(); return; }
  recordDeleted(t('undoWall'), () => {
    if (state.wall.length >= wallMax()) return false;
    set((s) => { const wall = s.wall.slice(); wall.splice(Math.min(index, wall.length), 0, item); return { wall }; });
    return true;
  }, del);
}
export function moveWall(id: string, toIndex: number): void {
  set((s) => {
    const from = s.wall.findIndex((w) => w.id === id);
    if (from < 0) return {};
    const wall = s.wall.slice(); const [it] = wall.splice(from, 1); wall.splice(Math.max(0, Math.min(wall.length, toIndex)), 0, it);
    return { wall };
  });
  scheduleSave();
}
export function openCrop(id: string | undefined): void { set({ cropId: id }); }

// ------------------------------------------------------------------ power-off images chosen in the camera's menu
export const validMenuId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 0xffffffff;
export function newMenuId(wall: readonly WallItem[]): number {
  for (;;) {
    const id = 1 + Math.floor(Math.random() * 0xfffffffe);
    // Never one of GR III round 5's picture numbers (k << 24, k <= 8), which share the stored bytes.
    if ((id & 0xffffff) === 0 && id >>> 24 <= 8) continue;
    if (!wall.some((w) => w.menuId === id)) return id;
  }
}
/** A camera-list name from a file name: printable ASCII only, at most SHUTDOWN_NAME_MAX characters. */
export function menuNameOf(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
  return (stem || 'Picture').slice(0, SHUTDOWN_NAME_MAX).trim();
}
export function setWallName(id: string, menuName: string): void { setWall(id, { menuName }); scheduleSave(); }
const SHUTDOWN_NAME_PROBLEMS: Record<string, Key> = { empty: 'wallNameEmpty', 'too-long': 'wallNameLong', 'bad-char': 'wallNameBad' };
/** Why an image cannot go into the camera's menu (null when it can). */
export function wallMenuProblem(w: WallItem): string | null {
  const p = validateShutdownName(w.menuName ?? '');
  if (p) return t(SHUTDOWN_NAME_PROBLEMS[p], { n: SHUTDOWN_NAME_MAX });
  if (w.busy) return t('converting');
  if (w.error || !w.menuJpeg) return w.error || t('encodeFailed');
  return null;
}
/** The pictures the firmware gets. */
export function menuPictures(s: State = state): ShutdownPictureSpec[] {
  return s.wall.filter((w) => !wallMenuProblem(w)).map((w) => ({ id: w.menuId!, name: w.menuName!.trim() === w.menuName ? w.menuName! : w.menuName!.trim(), jpeg: w.menuJpeg! }));
}
/** Every image is ready (names valid, encoded), and there is at least one. */
export function menuReady(s: State = state): boolean {
  return s.wall.length > 0 && s.wall.length <= SHUTDOWN_MAX_PICTURES && s.wall.every((w) => !wallMenuProblem(w));
}
export function setCrop(id: string, crop: Crop): void { setWall(id, { crop }); set({ cropId: undefined }); void encodeWall(id); scheduleSave(); }
