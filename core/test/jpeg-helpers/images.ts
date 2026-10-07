// Deterministic synthetic test images and image comparison helpers.

export const W = 720;
export const H = 480;

export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pixel = (x: number, y: number, rnd: () => number) => [number, number, number];

export function makeImage(fn: Pixel, width = W, height = H, seed = 7): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  const rnd = prng(seed);
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y, rnd);
      const i = (y * width + x) * 3;
      out[i] = clamp(r);
      out[i + 1] = clamp(g);
      out[i + 2] = clamp(b);
    }
  }
  return out;
}

export const flat = (r: number, g: number, b: number, width = W, height = H): Uint8Array => makeImage(() => [r, g, b], width, height);

/** Full-range uniform noise in every channel. */
export const noise = (seed = 7, width = W, height = H): Uint8Array =>
  makeImage((_x, _y, rnd) => [rnd() * 255, rnd() * 255, rnd() * 255], width, height, seed);

/** Smooth shapes plus fine texture and a little grain: compresses roughly like a photo. */
export const photoLike = (seed = 7, width = W, height = H): Uint8Array =>
  makeImage(
    (x, y, rnd) => {
      const t = Math.sin(x / 23) * Math.cos(y / 17) * 60 + Math.sin((x + y) / 5) * 12;
      const n = (rnd() - 0.5) * 14;
      return [128 + t + n + x / 12, 110 + t * 0.7 + n + y / 9, 100 - t * 0.5 + n];
    },
    width,
    height,
    seed,
  );

/** Two flat colours separated by a slanted edge. */
export const twoTone = (): Uint8Array => makeImage((x, y) => (x + y * 0.4 < 400 ? [30, 60, 140] : [230, 200, 60]));

/** A horizontal colour gradient between two tones. */
export const gradient = (): Uint8Array =>
  makeImage((x) => {
    const t = x / (W - 1);
    return [20 + t * 200, 40 + t * 60, 180 - t * 120];
  });

/** Luma of an RGB image written back to all three channels. */
export function toGrey(rgb: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    out[i] = out[i + 1] = out[i + 2] = Math.round(0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]);
  }
  return out;
}

export function psnr(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error('size mismatch');
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum === 0 ? Infinity : 10 * Math.log10((255 * 255) / (sum / a.length));
}

export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error('size mismatch');
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
