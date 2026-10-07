// Encode an image to a baseline JPEG whose total length is an exact number of
// bytes, reached only by choosing the quantisation tables (no COM segment, no
// padding, nothing after EOI).

import { JpegError } from './errors';
import { OVERHEAD_BYTES, ScanCoder, encodeCoefficients, forwardTransform, makeLayout, minimumJpegSize } from './encoder';
import type { Sampling } from './encoder';
import { qualityTables } from './tables';

export interface ExactJpegOptions {
  width: number;
  height: number;
  sampling: Sampling;
  /** Required total file length in bytes. */
  byteLength: number;
  /** Seed of the pseudo-random search (default 1). Same input + seed gives identical bytes. */
  seed?: number;
  /** Maximum number of trial encodes before giving up (default 4000). */
  maxIterations?: number;
  onProgress?: (fraction: number) => void;
}

export interface ExactJpegResult {
  data: Uint8Array;
  /** The IJG-style quality (1..100) whose tables the fine search started from. */
  quality: number;
  /** Number of trial encodes that were needed. */
  iterations: number;
  /** Final tables [luma, chroma] in zigzag order, exactly as written to the file. */
  qtables: [Uint8Array, Uint8Array];
}

export const DEFAULT_MAX_ITERATIONS = 4000;

/** Initial acceptance window (bytes) of the fine search. */
const INITIAL_WINDOW = 16;
/** Number of accepted moves during which a move may not be undone. */
const TABU_TENURE = 6;
/** How often a move with a promising remembered effect is preferred over a random one. */
const INFORMED_SHARE = 0.8;
/** A remembered effect is promising if it would end within this many bytes of the target. */
const INFORMED_TOLERANCE = 8;
/** Remembered effects that miss the acceptance range by more than this are not retried. */
const HOPELESS_MARGIN = 32;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Encode `rgb` (width * height * 3 bytes, row-major) so that the resulting file
 * is exactly `opts.byteLength` bytes long.
 *
 * Throws `JpegError('unreachable-size')` when the length cannot be reached:
 * immediately if it is below the structural minimum for the frame size, after
 * two trials if the image is too detailed (all-255 tables still too big) or too
 * plain (all-1 tables still too small), or when `maxIterations` is used up.
 */
export function encodeExactJpeg(rgb: Uint8Array | Uint8ClampedArray, opts: ExactJpegOptions): ExactJpegResult {
  if (!opts || typeof opts !== 'object') throw new JpegError('bad-input', 'options are required');
  const layout = makeLayout(opts.width, opts.height, opts.sampling);
  const target = opts.byteLength;
  if (!Number.isInteger(target) || target < 1) throw new JpegError('bad-input', `invalid byteLength ${target}`);
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) throw new JpegError('bad-input', `invalid maxIterations ${maxIterations}`);
  const seed = opts.seed ?? 1;
  if (!Number.isFinite(seed)) throw new JpegError('bad-input', `invalid seed ${seed}`);
  if (!rgb || rgb.length !== opts.width * opts.height * 3) {
    throw new JpegError('bad-input', `expected ${opts.width * opts.height * 3} RGB bytes, got ${rgb ? rgb.length : 0}`);
  }

  let lastProgress = 0;
  const progress = (f: number): void => {
    if (opts.onProgress && f > lastProgress) {
      lastProgress = f;
      opts.onProgress(f);
    }
  };

  const minBytes = minimumJpegSize(opts.width, opts.height, opts.sampling);
  if (target < minBytes) {
    throw new JpegError(
      'unreachable-size',
      `${target} bytes is below the smallest possible ${opts.width}x${opts.height} 4:${opts.sampling.slice(1, 2)}:${opts.sampling.slice(2)} file (${minBytes} bytes)`,
      { byteLength: target, minBytes },
    );
  }

  const scanTarget = target - OVERHEAD_BYTES;
  const coef = forwardTransform(rgb, layout);
  const coder = new ScanCoder(coef, layout);
  progress(0.1);

  let iterations = 0;
  /** Size of the scan with the coder's current tables; returns (file length - target). */
  const trial = (): number => {
    if (iterations >= maxIterations) {
      throw new JpegError('unreachable-size', `no table set gives exactly ${target} bytes within ${maxIterations} trials`, {
        byteLength: target,
        iterations,
      });
    }
    iterations++;
    return coder.countBytes() - scanTarget;
  };

  const finish = (quality: number): ExactJpegResult => {
    const qtables: [Uint8Array, Uint8Array] = [coder.tables[0].slice(), coder.tables[1].slice()];
    // The file is produced by the same plain path as `encodeJpeg`, independent of
    // the incremental state used during the search, and its length is re-checked.
    const data = encodeCoefficients(coef, layout, qtables[0], qtables[1]);
    if (data.length !== target) throw new Error(`internal error: final encode is ${data.length} bytes, expected ${target}`);
    progress(1);
    return { data, quality, iterations, qtables };
  };

  // --- 1. Is the target reachable at all? ---------------------------------
  const coarsest = qualityTables(1); // all 255
  coder.setTables(coarsest[0], coarsest[1]);
  let d = trial();
  if (d > 0) {
    throw new JpegError('unreachable-size', `image is too detailed: the coarsest tables still give ${target + d} bytes, target is ${target}`, {
      byteLength: target,
      minBytes: target + d,
    });
  }
  if (d === 0) return finish(1);
  const finest = qualityTables(100); // all 1
  coder.setTables(finest[0], finest[1]);
  d = trial();
  if (d < 0) {
    throw new JpegError('unreachable-size', `image is too plain: the finest tables only give ${target + d} bytes, target is ${target}`, {
      byteLength: target,
      maxBytes: target + d,
    });
  }
  if (d === 0) return finish(100);
  progress(0.15);

  // --- 2. Bracket the target between two adjacent qualities ----------------
  let lo = 1; // size(lo) < target
  let hi = 100; // size(hi) > target
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const t = qualityTables(mid);
    coder.setTables(t[0], t[1]);
    d = trial();
    if (d === 0) return finish(mid);
    if (d < 0) lo = mid;
    else hi = mid;
  }
  const quality = lo;
  progress(0.25);

  // --- 3. Bisect along a path of single-entry steps from T(lo) to T(hi) ----
  const rng = mulberry32(seed);
  const from = qualityTables(lo);
  const to = qualityTables(hi);
  // Every unit step decrements one entry by 1; steps of all entries are spread evenly over the path.
  const steps: { id: number; at: number }[] = [];
  for (let cls = 0; cls < 2; cls++) {
    for (let k = 0; k < 64; k++) {
      const n = from[cls][k] - to[cls][k];
      const jitter = rng();
      for (let j = 0; j < n; j++) steps.push({ id: cls * 64 + k, at: (j + jitter) / n });
    }
  }
  steps.sort((a, b) => a.at - b.at || a.id - b.id);
  const tablesAt = (m: number): [Uint8Array, Uint8Array] => {
    const t: [Uint8Array, Uint8Array] = [from[0].slice(), from[1].slice()];
    for (let i = 0; i < m; i++) t[steps[i].id >> 6][steps[i].id & 63]--;
    return t;
  };
  let a = 0; // size(a) < target
  let b = steps.length; // size(b) > target
  let dA = -Infinity;
  let dB = Infinity;
  while (b - a > 1) {
    const mid = (a + b) >> 1;
    const t = tablesAt(mid);
    coder.setTables(t[0], t[1]);
    d = trial();
    if (d === 0) return finish(quality);
    if (d < 0) {
      a = mid;
      dA = d;
    } else {
      b = mid;
      dB = d;
    }
  }
  {
    // continue from whichever end of the final bracket is closer to the target
    const m = -dA <= dB ? a : b;
    const t = tablesAt(m);
    coder.setTables(t[0], t[1]);
    d = m === a ? dA : dB;
    if (!Number.isFinite(d)) d = trial();
    if (d === 0) return finish(quality);
  }
  progress(0.35);

  // --- 4. Seeded local search over single table entries --------------------
  // A move changes one entry (class, zigzag index) in one direction to the
  // nearest value that alters the scan at all. Moves that bring the size closer
  // to the target, or keep it within a small window around it, are accepted.
  // The size change each move caused is remembered: repeating a move from a
  // slightly different state changes the size by nearly the same amount (give
  // or take a few bytes of 0xFF stuffing), so moves whose remembered effect
  // would land on the target are tried first.
  // Move id = class * 128 + zigzag index * 2 + (1 if coarser).
  const MOVES = 256;
  const tried = new Uint8Array(MOVES);
  const triedDelta = new Float64Array(MOVES);
  const dead = new Uint8Array(MOVES);
  const tabuUntil = new Int32Array(MOVES);
  const effect = new Float64Array(MOVES).fill(NaN);
  let accepted = 0;
  let window = INITIAL_WINDOW;
  const searchStart = iterations;

  const eligible = (id: number): boolean => tried[id] === 0 && dead[id] === 0 && tabuUntil[id] <= accepted;
  /** True when the move's remembered effect says it would certainly be rejected. */
  const hopeless = (id: number): boolean => {
    const e = effect[id];
    return e === e && Math.abs(d + e) > Math.max(Math.abs(d), window) + HOPELESS_MARGIN;
  };
  const pickMove = (): number => {
    if (rng() < INFORMED_SHARE) {
      let best = -1;
      let bestError = INFORMED_TOLERANCE + 1;
      for (let id = 0; id < MOVES; id++) {
        const e = effect[id];
        if (e === e && Math.abs(d + e) < bestError && eligible(id)) {
          best = id;
          bestError = Math.abs(d + e);
        }
      }
      if (best >= 0) return best;
    }
    for (let attempt = 0; attempt < 24; attempt++) {
      const cls = rng() < 0.5 ? 0 : 1;
      const u = rng();
      const k = 63 - Math.floor(64 * u * u); // prefers high frequencies: small effect on size and image
      const id = cls * 128 + k * 2 + (rng() < 0.5 ? 0 : 1);
      if (eligible(id) && !hopeless(id)) return id;
    }
    const rest: number[] = [];
    for (let id = 0; id < MOVES; id++) if (eligible(id) && !hopeless(id)) rest.push(id);
    if (rest.length === 0) for (let id = 0; id < MOVES; id++) if (eligible(id)) rest.push(id);
    return rest.length ? rest[Math.floor(rng() * rest.length)] : -1;
  };
  /** Apply a move; returns the entry's previous value, or 0 if the move cannot change anything. */
  const applyMove = (id: number): number => {
    const cls = id >> 7;
    const k = (id >> 1) & 63;
    const dir = id & 1 ? 1 : -1;
    const old = coder.tables[cls][k];
    let v = coder.nearestEffective(cls, k, dir);
    if (v === 0) return 0;
    while (v >= 1 && v <= 255) {
      if (coder.setEntry(cls, k, v) > 0) return old;
      v += dir;
    }
    coder.setEntry(cls, k, old);
    return 0;
  };
  const accept = (id: number, delta: number): void => {
    // the entry has a new value: its next step is unknown, the step back undoes this one
    effect[id] = NaN;
    effect[id ^ 1] = d - delta;
    d = delta;
    accepted++;
    tried.fill(0);
    dead[id] = 0;
    dead[id ^ 1] = 0;
    tabuUntil[id ^ 1] = accepted + TABU_TENURE;
  };

  for (;;) {
    const id = pickMove();
    if (id < 0) {
      // Every possible move from this state has been tried or is impossible:
      // widen the window and continue from the best neighbour.
      let best = -1;
      for (let i = 0; i < MOVES; i++) {
        if (tried[i] && (best < 0 || Math.abs(triedDelta[i]) < Math.abs(triedDelta[best]))) best = i;
      }
      if (best < 0) {
        // nothing was tried: release moves that are only blocked by the tabu rule, if any
        let released = false;
        for (let i = 0; i < MOVES; i++) {
          if (tabuUntil[i] > accepted && dead[i] === 0) {
            tabuUntil[i] = 0;
            released = true;
          }
        }
        if (released) continue;
        throw new JpegError('unreachable-size', `no table change can move the file size any further (${target + d} bytes, target ${target})`, {
          byteLength: target,
          iterations,
        });
      }
      const delta = triedDelta[best];
      applyMove(best);
      window = Math.max(window * 2, Math.abs(delta));
      accept(best, delta);
      continue;
    }
    const old = applyMove(id);
    if (old === 0) {
      dead[id] = 1;
      continue;
    }
    const delta = trial();
    if (delta === 0) return finish(quality);
    effect[id] = delta - d;
    const ad = Math.abs(delta);
    if (ad < Math.abs(d) || ad <= window) {
      accept(id, delta);
    } else {
      coder.setEntry(id >> 7, (id >> 1) & 63, old);
      tried[id] = 1;
      triedDelta[id] = delta;
    }
    if ((iterations & 15) === 0) progress(0.35 + 0.6 * (1 - Math.exp(-(iterations - searchStart) / 150)));
  }
}
