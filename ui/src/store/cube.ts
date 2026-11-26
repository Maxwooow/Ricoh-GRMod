import { color } from '@grmod/core';
import type { SlotId } from '@grmod/core';
import { host, isMobile } from '../host';
import { upload } from '../host-android';
import { t } from '../i18n';
import { SlotKey, State, fail, isExtra, slotOf, state, toast } from './core';
import { extraName } from './looks';

// ------------------------------------------------------------------ export a slot's look as a .cube
/**
 * @decision DEC-EXPORTCUBE-UI-001
 * @title "Export look as .cube" renders core's exportSlotCube from the slot's fitted params
 * @status accepted
 * @rationale The file is made by core (color/export-cube.ts, DEC-EXPORTCUBE-001 defines what it represents:
 *   the slot model applied to a Standard sRGB picture, colour and tone only, no halation or grain). The UI
 *   side only picks the camera model by family (GR III / IIIx: GR3X_CAMERA, else GR IV's), names the file
 *   after the slot (what the camera menu shows, made file-name safe) and saves it where the user says: the
 *   system's save dialog on the desktop (the folder chosen there may then be written) and in the Android app,
 *   the Files app on iOS, as firmware is. It needs
 *   a fitted result; a slot without one has no button.
 */
/** The name a slot has in the camera's menu, for file names: an added slot's name, else the language's name of a built-in one. */
export function slotLabel(k: SlotKey, s: State = state): string {
  if (isExtra(k)) { const x = s.extras.find((e) => e.key === k); return x ? extraName(x, s) : k; }
  const id = k as SlotId, off = s.info?.slots.find((x) => x.id === id);
  return s.slots[id]?.names[s.lang] || (s.info?.family === 'gr3x' ? off?.defaultName : id === 'CG' ? t('slotCG') : t('slotCY')) || id;
}
const fileSafe = (n: string): string => n.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'look';
function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
/** The .cube text of a slot's fitted look and the name it saves as; undefined without a fitted result. */
export function slotCube(k: SlotKey, s: State = state): { name: string; text: string } | undefined {
  const params = slotOf(k, s)?.preset?.result?.params;
  if (!params) return undefined;
  const name = slotLabel(k, s);
  return { name: fileSafe(name) + '.cube', text: color.exportSlotCube(params, { title: name, camera: s.info?.family === 'gr3x' ? 'gr3x' : 'gr4' }) };
}
export async function exportSlotCubeFile(k: SlotKey): Promise<void> {
  try {
    const c = slotCube(k);
    if (!c) { toast(t('exportCubeNone'), 'error'); return; }
    if (isMobile) {
      const r = await upload(new TextEncoder().encode(c.text), { to: 'download', name: c.name }) as { path?: string; cancelled?: boolean };
      if (!r.cancelled) toast(t('savedTo', { p: r.path ?? c.name }), 'ok');
      return;
    }
    if (!host.available) { downloadText(c.name, c.text, 'text/plain'); toast(t('exportCubeDone', { name: c.name }), 'ok'); return; }
    // the desktop: the system's save dialog, starting with the slot's name; the user picks the folder (and may rename)
    const path = await host.saveFile(t('exportCube'), c.name);
    if (!path) return;
    await host.write(path, new TextEncoder().encode(c.text));
    toast(t('savedTo', { p: path }), 'ok');
  } catch (e) { fail(e); }
}
