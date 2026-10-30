// SPDX-License-Identifier: GPL-2.0-only
/**
 * Translate an archived patch manifest (a research build of the old program, e.g. tools/gr3x/fixtures/
 * t2-patch-manifest.json) to the ported program, for the probes that compare a candidate with it
 * (development tool):
 *
 *   npx vite-node tools/port/translate_manifest.mts OLD-rtos NEW-rtos RUNS.json IN.json OUT.json NEW-PROFILE-ID NEW-RTOS-SHA
 *
 * Sites move to their mapped addresses (the new firmware's word there must be the old expected word
 * up to relocation), replacements and the appended payload are relocated word by word: branches to
 * the mapped target (or to the same place of the moved payload), address literals and movw/movt pairs
 * to the mapped address. A word that cannot be translated stops the run. The geometry sub-manifest
 * is translated the same way.
 */
import { readFileSync, writeFileSync } from 'node:fs';
const [oldRtosPath, newRtosPath, runsPath, inPath, outPath, profileId, rtosSha] = process.argv.slice(2);
const oldRtos = readFileSync(oldRtosPath), newRtos = readFileSync(newRtosPath);
const R = JSON.parse(readFileSync(runsPath, 'utf8'));
const runs: [number, number, number][] = R.runs;
const refs = new Map<number, number>(Object.entries(R.refs as Record<string, string>).map(([k, v]) => [parseInt(k, 16), parseInt(v, 16)]));
const overrides = new Map<number, number>(Object.entries(R.overrides as Record<string, string>).map(([k, v]) => [parseInt(k, 16), parseInt(v, 16)]));
const BASE = 0x53000000, oldAppend = BASE + R.oldLength, newAppend = BASE + R.newLength;
function T(a: number): number | undefined {
  if (a >= oldAppend && a < 0x55000000) return a - oldAppend + newAppend;
  if (overrides.has(a)) return overrides.get(a);
  let lo = 0, hi = runs.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1, [o, n, len] = runs[mid]; if (a < o) hi = mid - 1; else if (a >= o + len) lo = mid + 1; else return n + (a - o); }
  if (refs.has(a)) return refs.get(a);
  const ram = R.ram;
  if (a >= ram.base && a < ram.base + ram.oldLength) { const t = T(ram.oldSource + a - ram.base); if (t !== undefined) return ram.base + t - ram.newSource; }
  return undefined;
}
const isAddr = (v: number) => v >= 0x53000000 && v < 0x56000000;
const isBranch = (w: number) => (w & 0x0e000000) === 0x0a000000 && (w >>> 28) !== 0xf;
const target = (w: number, at: number) => { let off = w & 0xffffff; if (off & 0x800000) off -= 0x1000000; return (at + 8 + off * 4) >>> 0; };
const branchTo = (w: number, at: number, to: number) => ((w & 0xff000000) | (((to - at - 8) >> 2) & 0xffffff)) >>> 0;
const imm16 = (w: number) => ((w >>> 4) & 0xf000) | (w & 0xfff);
const setImm = (w: number, v: number) => ((w & 0xfff0f000) | ((v & 0xf000) << 4) | (v & 0xfff)) >>> 0;
const isMovw = (w: number) => (w & 0x0ff00000) === 0x03000000 && (w >>> 28) !== 0xf;
const isMovt = (w: number) => (w & 0x0ff00000) === 0x03400000 && (w >>> 28) !== 0xf;
const fail = (m: string): never => { throw new Error(m); };
const fw = (img: Buffer, a: number) => img.readUInt32LE(a - BASE);

/** Relocate the words of a block placed at `oldAt` (old) / `newAt` (new). */
function relocate(words: number[], oldAt: number, newAt: number, what: string): number[] {
  const out = words.slice();
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (isMovw(w)) {
      const rd = (w >>> 12) & 15;
      for (let k = 1; k <= 6 && i + k < words.length; k++) if (isMovt(words[i + k]) && ((words[i + k] >>> 12) & 15) === rd) {
        const v = ((imm16(words[i + k]) << 16) | imm16(w)) >>> 0;
        if (isAddr(v)) { const t = T(v) ?? fail(`${what} +${(4 * i).toString(16)}: movw/movt ${v.toString(16)} unmapped`); out[i] = setImm(w, t & 0xffff); out[i + k] = setImm(words[i + k], t >>> 16); }
        break;
      }
      continue;
    }
    if (isBranch(w)) {
      const to = target(w, oldAt + 4 * i);
      if (to >= oldAt && to < oldAt + 4 * words.length) { out[i] = branchTo(w, newAt + 4 * i, to - oldAt + newAt); continue; }
      const t = T(to);
      if (t === undefined) { if (isAddr(to)) fail(`${what} +${(4 * i).toString(16)}: branch to ${to.toString(16)} unmapped`); continue; } // data
      out[i] = branchTo(w, newAt + 4 * i, t);
      continue;
    }
    if (isAddr(w) && !isMovt(w)) { const t = T(w); if (t !== undefined) out[i] = t; }
  }
  return out;
}
const words = (hex: string) => { const b = Buffer.from(hex, 'hex'); const w: number[] = []; for (let i = 0; i + 4 <= b.length; i += 4) w.push(b.readUInt32LE(i)); return w; };
const hex = (w: number[]) => { const b = Buffer.alloc(w.length * 4); w.forEach((x, i) => b.writeUInt32LE(x >>> 0, i * 4)); return b.toString('hex'); };

function translate(m: any): any {
  const out = { ...m, profile: profileId, originalRtosSha256: rtosSha, originalLength: R.newLength };
  if (m.append) {
    if (m.append.address !== oldAppend) fail('append address');
    out.append = { ...m.append, address: newAppend, bytes: hex(relocate(words(m.append.bytes), oldAppend, newAppend, 'append')) };
  }
  const siteAt = new Map<number, any>(m.sites.map((x: any) => [x.address, x]));
  out.sites = m.sites.map((s: any) => {
    const t = T(s.address) ?? fail(`site ${s.address.toString(16)} unmapped`);
    const [e] = words(s.expected), [r] = words(s.replacement);
    if (fw(oldRtos, s.address) !== e) fail(`site ${s.address.toString(16)}: old expected word`);
    const ne = fw(newRtos, t);
    const [re] = relocate([e], s.address, t, `site ${s.address.toString(16)} expected`);
    if (re !== ne && !(isMovw(e) || isMovt(e))) fail(`site ${s.address.toString(16)}: new firmware word ${ne.toString(16)} is not the old ${e.toString(16)} relocated`);
    // movw / movt halves: the partner half is the other site's replacement or the old firmware's word
    // (same register, within 6 instructions); the pair's address is translated and this half taken.
    let nr: number;
    if (isMovw(r) || isMovt(r)) {
      const half = isMovt(r), rd = (r >>> 12) & 15;
      const patched = (a: number) => { const x = siteAt.get(a); return x ? words(x.replacement)[0] : fw(oldRtos, a); };
      let partner: number | undefined;
      for (let k = 1; k <= 6 && partner === undefined; k++) {
        const a = s.address + (half ? -4 * k : 4 * k), w = patched(a);
        if ((half ? isMovw(w) : isMovt(w)) && ((w >>> 12) & 15) === rd) partner = w;
      }
      if (partner === undefined) nr = r; // a plain constant (no other half): kept
      else {
      const full = (half ? (imm16(r) << 16 | imm16(partner!)) : (imm16(partner!) << 16 | imm16(r))) >>> 0;
      const tf = isAddr(full) ? (T(full) ?? fail(`site ${s.address.toString(16)}: address ${full.toString(16)} unmapped`)) : full;
      nr = setImm(r, half ? tf >>> 16 : tf & 0xffff);
      }
    } else nr = relocate([r], s.address, t, `site ${s.address.toString(16)} replacement`)[0];
    return { ...s, address: t, expected: hex([ne]), replacement: hex([nr]) };
  });
  if (m.geometry) out.geometry = translate(m.geometry);
  for (const key of ['entries'] as const) if (m[key]) out[key] = Object.fromEntries(Object.entries(m[key]).map(([k, v]) => [k, typeof v === 'number' && isAddr(v) ? (T(v) ?? fail(`entry ${k}`)) : v]));
  return out;
}
writeFileSync(outPath, JSON.stringify(translate(JSON.parse(readFileSync(inPath, 'utf8')))));
console.log('translated', inPath, '->', outPath);
