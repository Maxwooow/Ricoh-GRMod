/**
 * Android: the rubber band of iOS at the ends of a scrolling pane. Pulled past the top or the bottom, the content
 * follows the finger more and more stiffly and springs back when let go; a fling that runs into an end carries the
 * content a little past it and back. (iOS does this by itself; Chromium on Android stops dead, so this is Android only.)
 *
 * The content is moved with the `translate` property on the pane's children, which adds to any `transform` they have.
 * Panes that do not overflow, text fields and handles that drag (touch-action: none) are left alone, as is a look
 * being dragged in the look list (html.look-grabbing).
 */
const C = 0.55; // the stiffness of the band (UIScrollView's constant)
const W = 13; // the spring, rad/s: critically damped, settles in about a third of a second

interface Band { off: number; frame: number }
const bands = new WeakMap<HTMLElement, Band>();

const rubber = (x: number, d: number): number => Math.sign(x) * (1 - 1 / ((Math.abs(x) * C) / d + 1)) * d;
const unrubber = (y: number, d: number): number => { const a = Math.min(Math.abs(y), d * 0.95); return Math.sign(y) * ((a * d) / (C * (d - a))); };

function band(el: HTMLElement): Band {
  let b = bands.get(el);
  if (!b) { b = { off: 0, frame: 0 }; bands.set(el, b); }
  return b;
}

function put(el: HTMLElement, off: number): void {
  const b = band(el);
  b.off = Math.abs(off) < 0.25 ? 0 : off;
  const v = b.off ? `0 ${b.off.toFixed(2)}px` : '';
  for (const c of Array.from(el.children)) (c as HTMLElement).style.translate = v;
}

function stop(el: HTMLElement): void {
  const b = bands.get(el);
  if (b?.frame) { cancelAnimationFrame(b.frame); b.frame = 0; }
}

/** A critically damped spring from offset x0 with velocity v0 (px/s) back to 0. */
function spring(el: HTMLElement, x0: number, v0: number): void {
  stop(el);
  const b = band(el);
  const t0 = performance.now();
  const c1 = x0;
  const c2 = v0 + W * x0;
  const tick = (now: number): void => {
    const t = Math.max(0, now - t0) / 1000; // a frame can be stamped before t0
    const x = (c1 + c2 * t) * Math.exp(-W * t);
    if (t > 0.08 && Math.abs(x) < 0.3) { put(el, 0); b.frame = 0; return; }
    put(el, x);
    b.frame = requestAnimationFrame(tick);
  };
  b.frame = requestAnimationFrame(tick);
}

function paneOf(target: EventTarget | null): HTMLElement | null {
  let el = target instanceof Element ? (target as HTMLElement) : null;
  if (el?.closest('input, textarea, select, [contenteditable="true"]')) return null;
  for (; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.touchAction === 'none') return null;
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
  }
  return null;
}

const atTop = (el: HTMLElement): boolean => el.scrollTop <= 0.5;
const atBottom = (el: HTMLElement): boolean => el.scrollTop >= el.scrollHeight - el.clientHeight - 1;

export function installBounce(): void {
  // the finger on a pane
  let g: { el: HTMLElement; id: number; x0: number; y0: number; last: number; axis: 'x' | 'y' | null; raw: number; lastT: number; v: number } | null = null;
  // a fling after the finger left: the pane's scroll speed, to carry it past an end
  let fling: { el: HTMLElement; s: number; t: number; v: number; until: number } | null = null;

  const grabbing = (): boolean => document.documentElement.classList.contains('look-grabbing');

  window.addEventListener('touchstart', (e) => {
    fling = null;
    if (e.touches.length !== 1) { g = null; return; }
    const el = paneOf(e.target);
    if (!el) { g = null; return; }
    const tc = e.touches[0];
    const b = band(el);
    stop(el);
    // caught while springing back: hold it where it is
    g = { el, id: tc.identifier, x0: tc.clientX, y0: tc.clientY, last: tc.clientY, axis: null, raw: b.off ? unrubber(b.off, el.clientHeight) : 0, lastT: e.timeStamp, v: 0 };
    if (b.off) g.axis = 'y';
  }, { passive: true, capture: true });

  window.addEventListener('touchmove', (e) => {
    if (!g) return;
    const tc = Array.from(e.touches).find((x) => x.identifier === g!.id);
    if (!tc || e.touches.length !== 1 || grabbing()) { if (g.raw) spring(g.el, band(g.el).off, 0); g = null; return; }
    if (g.axis === null) {
      const dx = tc.clientX - g.x0, dy = tc.clientY - g.y0;
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      g.axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x';
      if (g.axis === 'x') { g = null; return; }
    }
    const step = tc.clientY - g.last;
    g.last = tc.clientY;
    const dt = Math.max(1, e.timeStamp - g.lastT);
    g.v = 0.6 * g.v + 0.4 * (step / dt) * 1000;
    g.lastT = e.timeStamp;
    const el = g.el;
    const was = g.raw;
    if (g.raw) {
      const r = g.raw + step;
      g.raw = Math.sign(r) === Math.sign(g.raw) ? r : 0;
    } else if ((step > 0 && atTop(el)) || (step < 0 && atBottom(el))) {
      g.raw = step;
    }
    if (g.raw || was) {
      if (e.cancelable) e.preventDefault();
      put(el, rubber(g.raw, el.clientHeight));
      if (g.raw > 0 && el.scrollTop > 0) el.scrollTop = 0;
    }
  }, { passive: false, capture: true });

  const end = (e: TouchEvent): void => {
    if (!g || Array.from(e.touches).some((x) => x.identifier === g!.id)) return;
    const { el } = g;
    const off = band(el).off;
    if (off) {
      // let go while pulled: back, a little faster when flicked back towards the content
      const v = Math.sign(g.v) === -Math.sign(off) ? Math.max(-3000, Math.min(3000, g.v)) * 0.5 : 0;
      spring(el, off, v);
    } else if (g.axis === 'y') {
      fling = { el, s: el.scrollTop, t: performance.now(), v: 0, until: performance.now() + 4000 };
    }
    g = null;
  };
  window.addEventListener('touchend', end, { passive: true, capture: true });
  window.addEventListener('touchcancel', end, { passive: true, capture: true });

  // the scroll that goes on after the finger: when it runs into an end with speed left, overshoot and come back
  document.addEventListener('scroll', (e) => {
    const f = fling;
    if (!f || e.target !== f.el) return;
    const now = performance.now();
    if (now > f.until) { fling = null; return; }
    const s = f.el.scrollTop;
    const dt = now - f.t;
    if (dt > 0) f.v = dt > 80 ? 0 : 0.5 * f.v + 0.5 * ((s - f.s) / dt) * 1000; // px/s, + = towards the bottom
    f.s = s; f.t = now;
    const top = atTop(f.el) && f.v < -250, bottom = atBottom(f.el) && f.v > 250;
    if (top || bottom) {
      fling = null;
      // the content keeps its speed past the end (offset grows the other way to the scroll), capped like iOS
      const v = Math.max(-4200, Math.min(4200, -f.v));
      spring(f.el, 0, v);
    }
  }, { passive: true, capture: true });
}
