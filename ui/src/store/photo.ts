import { host } from '../host';
import { loadBitmap, workingCopy } from '../pixels';
import { decodePreview } from '../preview';
import defaultPhotoUrl from '../assets/preview.jpg';
import { PreviewMode, RatioBackdrop, SlotKey, fail, set, state } from './core';
import { scheduleSave } from './families';

// ------------------------------------------------------------------ preview photo
const PREVIEW_KEY = 'preview.jpg';
let photo: ImageData | null = null;
/** The picture the slot previews are drawn on; changes whenever `photoRev` does. */
export const previewPhoto = (): ImageData | null => photo;
export async function loadPreviewPhoto(): Promise<void> {
  try {
    // the user's own choice first, then a `preview.jpg` kept next to the program, then the sample built in
    let bytes = await host.storeGet(PREVIEW_KEY).catch(() => null);
    if (!bytes) bytes = await host.sidecar(PREVIEW_KEY).catch(() => null);
    if (!bytes) bytes = new Uint8Array(await (await fetch(defaultPhotoUrl)).arrayBuffer());
    photo = await decodePreview(bytes);
    set((s) => ({ photoRev: s.photoRev + 1 }));
  } catch (e) { console.warn('preview photo', e); }
}
export async function loadPreviewFile(file: File): Promise<void> {
  try {
    const bmp = await loadBitmap(file);
    const wc = await workingCopy(bmp, 1600);
    bmp.close();
    photo = await decodePreview(wc.blob);
    set((s) => ({ photoRev: s.photoRev + 1, previewMode: 'photo', ratioBackdrop: 'photo' }));
    if (host.available) await host.storeSet(PREVIEW_KEY, new Uint8Array(await wc.blob.arrayBuffer())).catch(() => undefined);
    scheduleSave();
  } catch (e) { fail(e); }
}
export function setPreviewMode(previewMode: PreviewMode): void { set({ previewMode }); scheduleSave(); }
export function setRatioBackdrop(ratioBackdrop: RatioBackdrop): void { set({ ratioBackdrop }); scheduleSave(); }
/** The slot the preview on the right shows. */
export function setActiveSlot(id: SlotKey): void { if (state.activeSlot !== id) set({ activeSlot: id }); }

/** The desktop builds (Windows, macOS, Linux) can eject a card; the development build cannot. */
export const canEject = (): boolean => host.info?.kind === 'windows' || host.info?.kind === 'mac' || host.info?.kind === 'linux';
