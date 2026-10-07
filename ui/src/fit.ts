// The window is the page: nothing scrolls and nothing can be zoomed. Below the size the layout
// was designed for, the whole interface is scaled down uniformly instead of being cut off.
import { host } from './host';

export const DESIGN_W = 1040;
export const DESIGN_H = 680;

let scale = 1;
/** Current uniform scale of the interface (1 unless the window is smaller than the design size). */
export const uiScale = (): number => scale;

const listeners = new Set<() => void>();
export function onUiScale(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }

function apply(): void {
  const s = Math.min(1, window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
  const next = Math.max(0.5, Math.round(s * 1000) / 1000);
  const root = document.getElementById('root');
  if (root) {
    root.style.setProperty('--ui-scale', String(next));
    root.classList.toggle('scaled', next !== 1);
  }
  if (next !== scale) { scale = next; listeners.forEach((f) => f()); }
}

// Caption colours of the native window; keep in step with --side / --text in styles.css.
const CHROME = { light: { caption: '#f7f7f5', text: '#37352f' }, dark: { caption: '#202020', text: '#d6d6d6' } };

export function installWindowBehaviour(): void {
  // no browser zoom: Ctrl+wheel (which is also what a touchpad pinch sends) and Ctrl +/-/0
  window.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false, capture: true });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '_', '0'].includes(e.key)) e.preventDefault();
  }, true);
  // Safari-style gesture events, where they exist
  for (const type of ['gesturestart', 'gesturechange']) window.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  window.addEventListener('resize', apply);
  apply();

  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const chrome = (): void => { const c = dark.matches ? CHROME.dark : CHROME.light; void host.windowChrome({ ...c, dark: dark.matches }); };
  dark.addEventListener('change', chrome);
  chrome();
}
