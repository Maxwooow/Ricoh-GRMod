// Android: "liquid glass" for the floating bottom tabs, after Kyant0/AndroidLiquidGlass (whose effect is a shader
// over the view behind). Here the same idea in the WebView (Chromium): `backdrop-filter` with an SVG filter whose
// displacement map bends what is behind the glass near its rim, the way a thick, rounded pane of glass refracts.
// The maps are drawn on a canvas for the size of each piece of glass.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** Signed distance from (x, y) to a rounded rectangle centred on 0 with half size (hw, hh), corner radius r. */
function sdBox(x: number, y: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(x) - hw + r;
  const qy = Math.abs(y) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * A displacement map for feDisplacementMap: red = x, green = y, 128 = no shift. Within `rim` px of the edge the
 * backdrop is pulled from further out along the edge's normal (the rim bends light like the curved edge of a lens);
 * `zoom` (0 = none) also magnifies the middle a little.
 */
export function glassMap(w: number, h: number, r: number, rim: number, zoom = 0, scale = 2): string {
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (!g) return '';
  const img = g.createImageData(W, H);
  const hw = w / 2;
  const hh = h / 2;
  const rr = Math.min(r, hw, hh);
  const e = 0.5;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = (i + 0.5) / scale - hw;
      const y = (j + 0.5) / scale - hh;
      const d = sdBox(x, y, hw, hh, rr);
      let dx = 0;
      let dy = 0;
      const t = -d; // depth inside the glass
      if (t >= 0 && t < rim) {
        // the edge's outward normal (gradient of the distance)
        const nx = sdBox(x + e, y, hw, hh, rr) - sdBox(x - e, y, hw, hh, rr);
        const ny = sdBox(x, y + e, hw, hh, rr) - sdBox(x, y - e, hw, hh, rr);
        const nl = Math.hypot(nx, ny) || 1;
        // a circular profile: flat inside, steep at the very edge
        const u = 1 - t / rim;
        const m = 1 - Math.sqrt(Math.max(0, 1 - u * u));
        dx = (nx / nl) * m;
        dy = (ny / nl) * m;
      }
      if (zoom) {
        dx -= (x / hw) * zoom;
        dy -= (y / hh) * zoom;
      }
      const k = (j * W + i) * 4;
      img.data[k] = Math.round(128 + Math.max(-1, Math.min(1, dx)) * 127);
      img.data[k + 1] = Math.round(128 + Math.max(-1, Math.min(1, dy)) * 127);
      img.data[k + 2] = 128;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL();
}

/** The size of an element, kept up to date. */
export function useSize(ref: RefObject<HTMLElement>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (): void => setSize((o) => (o.w === el.offsetWidth && o.h === el.offsetHeight ? o : { w: el.offsetWidth, h: el.offsetHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * An SVG filter for `backdrop-filter: url(#id)`: bends the backdrop of a w×h piece of glass with radius r.
 * `strength` is the largest shift in px.
 */
export function GlassFilter({ id, w, h, r, rim, strength, zoom = 0 }: { id: string; w: number; h: number; r: number; rim: number; strength: number; zoom?: number }) {
  const [map, setMap] = useState('');
  useEffect(() => { if (w > 0 && h > 0) setMap(glassMap(w, h, r, rim, zoom)); }, [w, h, r, rim, zoom]);
  if (!map) return null;
  return (
    <filter id={id} x="0" y="0" width={w} height={h} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
      <feImage href={map} x="0" y="0" width={w} height={h} preserveAspectRatio="none" result="map" />
      <feDisplacementMap in="SourceGraphic" in2="map" scale={strength * 2} xChannelSelector="R" yChannelSelector="G" />
    </filter>
  );
}

/** The SVG that holds the filters (it takes no room). */
export function GlassDefs({ children }: { children: React.ReactNode }) {
  return <svg className="glass-defs" width="0" height="0" aria-hidden focusable="false"><defs>{children}</defs></svg>;
}

/** Glass for a plain element (a button): its own filter, sized to it. */
export function useGlass(id: string, opts: { rim: number; strength: number; radius?: number }): { ref: RefObject<HTMLButtonElement>; filter: React.ReactNode } {
  const ref = useRef<HTMLButtonElement>(null);
  const { w, h } = useSize(ref);
  return { ref, filter: <GlassFilter id={id} w={w} h={h} r={opts.radius ?? h / 2} rim={opts.rim} strength={opts.strength} /> };
}
