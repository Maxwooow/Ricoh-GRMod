/**
 * Motion helpers (Web Animations API): an element moved from where its predecessor was to where it is now
 * ("first, last, invert, play"), staggered entrances and short exits. Nothing here changes layout or leaves a
 * style behind: an animation that is skipped or cut short ends in the same picture.
 *
 * With "reduce motion" asked for by the system every helper is a no-op (styles.css switches the CSS animations
 * and transitions off for the same setting).
 */

/** The curve of the app's larger movements (the views' track, the tour): fast out, long settle. */
export const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
/** For what leaves: starts slowly, is gone quickly. */
export const EASE_EXIT = 'cubic-bezier(0.4, 0, 1, 1)';

export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A box in the viewport. */
export interface Box { left: number; top: number; width: number; height: number }
export const boxOf = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };

type El = HTMLElement | SVGElement;
const can = (el: El | null | undefined): el is El => !!el && typeof el.animate === 'function' && !reducedMotion();

export interface FlipOptions {
  duration?: number;
  delay?: number;
  /** 'both': from the box's size too (pictures); 'none': from its place only (cards with text, which must not stretch). */
  scale?: 'both' | 'none';
  /** The opacity it starts from (1: no fade). */
  fade?: number;
  /** Added to the start: the movement of an animated ancestor (same duration and curve), which the element rides on. */
  carry?: { dx: number; dy: number };
}

/** The offset from where `el` is now to the box `from`. */
export const offsetTo = (el: Element, from: Box): { dx: number; dy: number } => { const to = boxOf(el); return { dx: from.left - to.left, dy: from.top - to.top }; };

/** Move `el` from the box `from` to where it is now. */
export function flipFrom(el: El | null | undefined, from: Box | null | undefined, o: FlipOptions = {}): Animation | null {
  if (!can(el) || !from) return null;
  const to = boxOf(el);
  if (!to.width || !to.height) return null;
  const dx = from.left - to.left - (o.carry?.dx ?? 0);
  const dy = from.top - to.top - (o.carry?.dy ?? 0);
  const scale = o.scale === 'none' ? '' : ` scale(${from.width / to.width}, ${from.height / to.height})`;
  const first: Keyframe = { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px)${scale}` };
  const last: Keyframe = { transformOrigin: '0 0', transform: 'none' };
  if (o.fade !== undefined && o.fade < 1) { first.opacity = o.fade; last.opacity = 1; }
  return el.animate([first, last], { duration: o.duration ?? 460, delay: o.delay ?? 0, easing: EASE, fill: 'backwards' });
}

export interface RiseOptions { duration?: number; delay?: number; stagger?: number; y?: number; scale?: number }

/** Let elements come in one after the other: from transparent, a little lower (and, with `scale`, a little smaller). */
export function rise(els: Iterable<Element | null | undefined>, o: RiseOptions = {}): void {
  let i = 0;
  for (const el of els) {
    if (!can(el as El)) continue;
    const from = `translateY(${o.y ?? 8}px)${o.scale ? ` scale(${o.scale})` : ''}`;
    (el as El).animate([{ opacity: 0, transform: from }, { opacity: 1, transform: 'none' }],
      { duration: o.duration ?? 340, delay: (o.delay ?? 0) + i * (o.stagger ?? 40), easing: EASE, fill: 'backwards' });
    i += 1;
  }
}

/** Let elements go (they stay gone until removed: the caller swaps the view when the promise settles). */
export function leave(els: Iterable<Element | null | undefined>, duration = 130, scale = 0.985): Promise<void> {
  const runs: Promise<unknown>[] = [];
  for (const el of els) {
    if (!can(el as El)) continue;
    runs.push((el as El).animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `scale(${scale})` }], { duration, easing: EASE_EXIT, fill: 'forwards' }).finished.catch(() => undefined));
  }
  return Promise.all(runs).then(() => undefined);
}

/** The nearest ancestor that scrolls vertically (the additions' list on a computer, the stage on a phone). */
export function scrollerOf(el: Element | null): HTMLElement | null {
  for (let p = el instanceof HTMLElement ? el : el?.parentElement ?? null; p && p !== document.body; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return document.querySelector<HTMLElement>('.stage');
}
