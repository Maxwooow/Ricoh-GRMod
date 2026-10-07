// SPDX-License-Identifier: GPL-2.0-only
/**
 * Exact rational numbers on BigInt, with the handful of operations Python's `fractions.Fraction`
 * provides and the reference implementation relies on (floor division, round-half-even).
 */
function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

/** Floor division for BigInt (JavaScript's `/` truncates toward zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

export class Frac {
  readonly n: bigint;
  /** Always positive. */
  readonly d: bigint;

  constructor(n: bigint | number, d: bigint | number = 1n) {
    let nn = BigInt(n);
    let dd = BigInt(d);
    if (dd === 0n) throw new RangeError('zero denominator');
    if (dd < 0n) {
      nn = -nn;
      dd = -dd;
    }
    const g = gcd(nn, dd);
    this.n = g === 0n ? 0n : nn / g;
    this.d = g === 0n ? 1n : dd / g;
  }

  mul(o: Frac | bigint | number): Frac {
    const f = o instanceof Frac ? o : new Frac(o);
    return new Frac(this.n * f.n, this.d * f.d);
  }

  div(o: Frac | bigint | number): Frac {
    const f = o instanceof Frac ? o : new Frac(o);
    return new Frac(this.n * f.d, this.d * f.n);
  }

  add(o: Frac | bigint | number): Frac {
    const f = o instanceof Frac ? o : new Frac(o);
    return new Frac(this.n * f.d + f.n * this.d, this.d * f.d);
  }

  cmp(o: Frac | bigint | number): number {
    const f = o instanceof Frac ? o : new Frac(o);
    const l = this.n * f.d;
    const r = f.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  eq(o: Frac | bigint | number): boolean {
    return this.cmp(o) === 0;
  }

  /** Python `self // 1`. */
  floor(): bigint {
    return floorDiv(this.n, this.d);
  }

  /** Python `round(self)`: nearest integer, ties to even. */
  round(): bigint {
    const fl = floorDiv(this.n, this.d);
    const twice = 2n * (this.n - fl * this.d);
    if (twice < this.d) return fl;
    if (twice > this.d) return fl + 1n;
    return fl % 2n === 0n ? fl : fl + 1n;
  }

  toNumber(): number {
    return Number(this.n) / Number(this.d);
  }

  static min(a: Frac, b: Frac): Frac {
    return a.cmp(b) <= 0 ? a : b;
  }
}

/** Convert a BigInt that must fit a JavaScript safe integer. */
export function toInt(v: bigint): number {
  const x = Number(v);
  if (!Number.isSafeInteger(x)) throw new RangeError('integer out of range');
  return x;
}

/** Integer square root (floor) of a non-negative BigInt. */
export function isqrt(v: bigint): bigint {
  if (v < 0n) throw new RangeError('negative');
  if (v < 2n) return v;
  let x = BigInt(Math.floor(Math.sqrt(Number(v))));
  while (x * x > v) x -= 1n;
  while ((x + 1n) * (x + 1n) <= v) x += 1n;
  return x;
}
