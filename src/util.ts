/** Small deterministic helpers: hashing, RNG, quantiles, rounding. */

import { createHash } from 'node:crypto';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = walk(obj[key]);
    return out;
  };
  return JSON.stringify(walk(value));
}

export function hashOf(value: unknown): string {
  return sha256(stableStringify(value)).slice(0, 16);
}

/** mulberry32 — deterministic, fast. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromString(s: string): number {
  const h = createHash('sha256').update(s).digest();
  return h.readUInt32BE(0);
}

export function normalRng(seed: number): () => number {
  const rng = makeRng(seed);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

export type QuantileMethod = 'linear';

/** Type-7 quantile (R default / numpy linear). Returns null for empty input. */
export function quantile(sorted: number[], p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return quantile(s, 0.5);
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Sample standard deviation (n-1). Null for fewer than 2 values. */
export function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const ss = values.reduce((a, b) => a + (b - m) * (b - m), 0);
  return Math.sqrt(ss / (values.length - 1));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function round(x: number | null, digits = 2): number | null {
  if (x === null || !Number.isFinite(x)) return null;
  const f = 10 ** digits;
  const v = Math.round(x * f) / f;
  return Object.is(v, -0) ? 0 : v;
}

/** Pair the middle 80% of observations into contiguous 5-interval (75 min) blocks. */
export function crewBlocks<T>(items: T[]): T[][] {
  const start = Math.floor(items.length / 2) % 5;
  const blocks: T[][] = [];
  for (let i = start; i + 5 <= items.length; i += 5) {
    blocks.push(items.slice(i, i + 5));
  }
  return blocks;
}

export function sum(values: Array<number | null>): number {
  let t = 0;
  for (const v of values) if (v !== null && Number.isFinite(v)) t += v;
  return t;
}

export function fmtKwh(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return '—';
  return x.toFixed(1);
}

export function fmtPct(x: number | null, digits = 1): string {
  if (x === null || !Number.isFinite(x)) return '—';
  return `${x.toFixed(digits)}%`;
}
