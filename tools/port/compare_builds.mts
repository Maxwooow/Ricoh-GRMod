// SPDX-License-Identifier: GPL-2.0-only
/**
 * Compare a GR III / IIIx build on the old program with the same build on the ported one
 * (development tool, not part of the program):
 *
 *   npx vite-node tools/port/compare_builds.mts OLD.bin NEW.bin RUNS.json [config...]
 *
 * RUNS.json is `addrmap.py --runs` output (the whole word alignment, the unanimous references and
 * the overrides). Both files are built through the app's engine with the same settings; then every
 * patch site of the old build must be a patch site of the new one at the mapped address, and every
 * word (each site's expected and replacement word, every word of the appended code and data) must be
 * the same, or the same up to relocation: a branch to the mapped target, a literal or a movw/movt
 * pair holding the mapped address, an address in GR Mod's appended block moved with the block.
 * Everything else is printed; the port's hand edits are expected to show up there and nowhere else.
 */
import { readFileSync } from 'node:fs';
const { Engine, gr3BuildManifests } = await import('../../core/src/app/engine.ts');
const { encodeGr3xPicture } = await import('../../core/src/fw/gr3x/shutdown.ts');
const { GR3X_FILM_IDS } = await import('../../core/src/fw/gr3x/look-resources.ts');

const [oldPath, newPath, runsPath, ...wanted] = process.argv.slice(2);
const R = JSON.parse(readFileSync(runsPath, 'utf8'));
const runs: [number, number, number][] = R.runs;
const refs = new Map<number, number>(Object.entries(R.refs as Record<string, string>).map(([k, v]) => [parseInt(k, 16), parseInt(v, 16)]));
const overrides = new Map<number, number>(Object.entries(R.overrides as Record<string, string>).map(([k, v]) => [parseInt(k, 16), parseInt(v, 16)]));
const BASE = 0x53000000;
let appendOld = 0, appendNew = 0, appendLength = 0;
let appendT: (a: number) => number | undefined = () => undefined;
function T(a: number): number | undefined {
  if (overrides.has(a)) return overrides.get(a);
  if (a >= appendOld && a < appendOld + appendLength) return appendT(a);
  // runs are sorted by old address
  let lo = 0, hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, [o, n, len] = runs[mid];
    if (a < o) hi = mid - 1; else if (a >= o + len) lo = mid + 1; else return n + (a - o);
  }
  if (refs.has(a)) return refs.get(a);
  const ram = R.ram;
  if (a >= ram.base && a < ram.base + ram.oldLength) {
    const t = T(ram.oldSource + a - ram.base);
    if (t !== undefined) return ram.base + t - ram.newSource;
  }
  return undefined;
}
const isAddr = (v: number) => v >= 0x53000000 && v < 0x56000000;
const target = (w: number, at: number) => { let off = w & 0xffffff; if (off & 0x800000) off -= 0x1000000; return (at + 8 + off * 4) >>> 0; };
const isBranch = (w: number) => (w & 0x0e000000) === 0x0a000000 && (w >>> 28) !== 0xf;
const imm16 = (w: number) => ((w >>> 4) & 0xf000) | (w & 0xfff);
const isMovw = (w: number) => (w & 0x0ff00000) === 0x03000000 && (w >>> 28) !== 0xf;
const isMovt = (w: number) => (w & 0x0ff00000) === 0x03400000 && (w >>> 28) !== 0xf;

/** Words at the same place of two code/data blocks; returns the problems. */
function compareWords(what: string, ow: number[], nw: number[], oAt: number, nAt: number): string[] {
  const out: string[] = [];
  if (ow.length !== nw.length) return [`${what}: ${ow.length} words vs ${nw.length}`];
  const pairOk = new Set<number>();
  for (let i = 0; i < ow.length; i++) {
    if (!isMovw(ow[i]) || !isMovw(nw[i])) continue;
    const rd = (ow[i] >>> 12) & 15;
    for (let k = 1; k <= 6 && i + k < ow.length; k++) {
      if (isMovt(ow[i + k]) && ((ow[i + k] >>> 12) & 15) === rd && isMovt(nw[i + k]) && ((nw[i + k] >>> 12) & 15) === rd) {
        const vo = (imm16(ow[i + k]) << 16 | imm16(ow[i])) >>> 0, vn = (imm16(nw[i + k]) << 16 | imm16(nw[i])) >>> 0;
        if (isAddr(vo) ? T(vo) === vn : vo === vn) { pairOk.add(i); pairOk.add(i + k); }
        else out.push(`${vo === vn ? 'SAME ' : ''}${what} +${(4 * i).toString(16)}: movw/movt ${vo.toString(16)} -> ${vn.toString(16)} (mapped ${T(vo)?.toString(16)})`);
        break;
      }
    }
  }
  for (let i = 0; i < ow.length; i++) {
    const v = ow[i], u = nw[i], a = oAt + 4 * i, b = nAt + 4 * i;
    if (pairOk.has(i)) continue;
    if (isBranch(v) && isBranch(u) && (v >>> 24) === (u >>> 24)) {
      const t = T(target(v, a));
      if (t === target(u, b)) continue;
      out.push(`${v === u ? 'SAME ' : ''}${what} +${(4 * i).toString(16)}: branch ${target(v, a).toString(16)} -> ${target(u, b).toString(16)} (mapped ${t?.toString(16)})`);
      continue;
    }
    if (isAddr(v)) {
      const t = T(v);
      if (t === u) continue;
      if (v === u && t === undefined) { out.push(`SAME ${what} +${(4 * i).toString(16)}: unmapped address word ${v.toString(16)}`); continue; }
      out.push(`${v === u ? 'SAME ' : ''}${what} +${(4 * i).toString(16)}: address ${v.toString(16)} -> ${u.toString(16)} (mapped ${t?.toString(16)})`);
      continue;
    }
    if (v !== u) out.push(`${what} +${(4 * i).toString(16)}: ${v.toString(16)} -> ${u.toString(16)}`);
  }
  return out;
}
/** Normalised word for alignment: branch offsets, address literals and movw/movt immediates masked. */
const norm = (w: number) => isBranch(w) ? (w & 0xff000000) >>> 0 : isAddr(w) ? 0x53000000 : (isMovw(w) || isMovt(w)) ? (w & 0xfff0f000) >>> 0 : w;
/** Longest-common-subsequence pairing of two word lists by their normalised words (Myers-free O(n*d) greedy on runs). */
function align(a: number[], b: number[]): [number, number][] {
  const out: [number, number][] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (norm(a[i]) === norm(b[j])) { out.push([i, j]); i++; j++; continue; }
    // find the nearest resynchronisation: 8 equal normalised words
    let best: [number, number] | null = null;
    for (let d = 1; d < 4096 && !best; d++) for (let k = 0; k <= d && !best; k++) {
      const x = i + k, y = j + d - k;
      if (x + 8 > a.length || y + 8 > b.length) continue;
      let ok = true; for (let t = 0; t < 8; t++) if (norm(a[x + t]) !== norm(b[y + t])) { ok = false; break; }
      if (ok) best = [x, y];
    }
    if (!best) break;
    [i, j] = best;
  }
  return out;
}
/** A reported pair of words that are the same word (data that only looks like an address or a branch). */
const isIdentical = (p: string) => { const m = /(address|movw\/movt) (\w+) -> (\w+)/.exec(p); if (m) return m[2] === m[3]; return /unmapped address word/.test(p) || /branch \w+ -> \w+/.test(p) && /\+\w+: branch (\w+) -> (\w+) \(mapped undefined\)/.test(p) === false && false; };
const words = (hex: string) => { const b = Buffer.from(hex, 'hex'); const w: number[] = []; for (let i = 0; i + 4 <= b.length; i += 4) w.push(b.readUInt32LE(i)); return w; };

const { Firmware, sectionsOf } = await import('../../core/src/fw/container.ts');
const rawOld = new Uint8Array(readFileSync(oldPath)), rawNew = new Uint8Array(readFileSync(newPath));
const rtosOfficial = (raw: Uint8Array) => { const d = new Firmware(raw).decoded; const r = sectionsOf(d).find((x: any) => x.name === 'RTOS')!; return Buffer.from(d.subarray(r.offset, r.offset + r.size)); };
const origOld = rtosOfficial(rawOld), origNew = rtosOfficial(rawNew);
const eOld = await Engine.open(rawOld), eNew = await Engine.open(rawNew);
const curve = Array.from({ length: 256 }, (_, i) => Math.min(16383, Math.round(16383 * Math.pow(i / 255, 0.8))));
const preset = { matrixQ13: Int16Array.from([9100, -600, -308, -300, 8800, -308, -100, -700, 8992]), curves: [Uint16Array.from(curve), Uint16Array.from(curve), Uint16Array.from(curve)] };
const rgb = new Uint8Array(720 * 480 * 3).map((_, i) => (i * 7 + (i >> 11)) & 255);
const pics = (n: number) => Array.from({ length: n }, (_, k) => ({ id: 0x1007 + k, name: `Pic ${k + 1}`, jpeg: encodeGr3xPicture(rgb.map((v, i) => (v + k * 40 + (i % 3) * 10) & 255)) }));
const films = (n: number) => GR3X_FILM_IDS.slice(0, n).map((slot, i) => ({ slot, names: { en: `Film ${i + 1}` }, ...(i % 4 === 0 ? { preset } : {}) }));
const order = [64, 11, 12, 13, 14, 15, 16, 22, 17, 18, 19, 20, 21, ...Array.from({ length: 19 }, (_, k) => 65 + k)];
const two = [{ ratio: '2.39:1', name: 'Scope' }, { ratio: '4:3', name: '4:3' }];
const seven = ['2.39:1', '4:3', '16:9', '65:24', '17:6', '7:6', '5:4'].map(r => ({ ratio: r, name: r }));
const configs: Record<string, Parameters<InstanceType<typeof Engine>['buildFirmware']>> = {
  full: [films(20), two, [], { filmCount: 20, adjSoftFocus: true, dateStamp: true, shutdownPictures: pics(2), lookLayout: { order, hidden: [18, 83] } }],
  max: [films(20), seven, [], { filmCount: 20, adjSoftFocus: true, dateStamp: true, shutdownPictures: pics(8) }],
  r9: [films(20), two, [], { filmCount: 20, adjSoftFocus: true, dateStamp: true, shutdownPictures: pics(1), gr3Round: 9 }],
  r7: [films(20), two, [], { filmCount: 20, adjSoftFocus: true, dateStamp: true, gr3Round: 7 }],
  nofilms: [[], two, [], { dateStamp: true, shutdownPictures: pics(1) }],
  ratios: [[], seven, [], {}],
  films9: [films(9), two, [], { filmCount: 9, adjSoftFocus: true }],
};
let failures = 0;
for (const name of wanted.length ? wanted : Object.keys(configs)) {
  const args = configs[name];
  const bo = await eOld.buildFirmware(...args), bn = await eNew.buildFirmware(...args);
  const mo = gr3BuildManifests.get(bo.sha256) as any, mn = gr3BuildManifests.get(bn.sha256) as any;
  appendOld = mo.append.address; appendNew = mn.append.address; appendLength = mo.append.bytes.length / 2;
  if (process.env.DUMP) { const { writeFileSync } = await import('node:fs'); writeFileSync(`${process.env.DUMP}/${name}-old.bin`, Buffer.from(mo.append.bytes, 'hex')); writeFileSync(`${process.env.DUMP}/${name}-new.bin`, Buffer.from(mn.append.bytes, 'hex')); writeFileSync(`${process.env.DUMP}/${name}-old.json`, JSON.stringify(mo.entries)); writeFileSync(`${process.env.DUMP}/${name}-new.json`, JSON.stringify(mn.entries)); }
  const problems: string[] = [];
  if (BASE + R.oldLength !== appendOld || BASE + R.newLength !== appendNew) problems.push(`append addresses ${appendOld.toString(16)} / ${appendNew.toString(16)}`);
  {
    const ow = words(mo.append.bytes), nw = words(mn.append.bytes), pairs = align(ow, nw);
    // Map appended addresses through the alignment from now on.
    const blockMap = new Map<number, number>(pairs.map(([x, y]) => [appendOld + 4 * x, appendNew + 4 * y]));
    appendT = (a: number) => blockMap.get(a & ~3) !== undefined ? blockMap.get(a & ~3)! + (a & 3) : undefined;
    let x0 = 0, y0 = 0;
    for (const [x, y] of [...pairs, [ow.length, nw.length] as [number, number]]) {
      if (x > x0 || y > y0) problems.push(`appended block: old +${(4 * x0).toString(16)} (${x - x0} words) / new +${(4 * y0).toString(16)} (${y - y0} words) differ`);
      x0 = x + 1; y0 = y + 1;
    }
    // runs of paired words, compared with relocation
    let start = 0;
    for (let k = 1; k <= pairs.length; k++) {
      if (k < pairs.length && pairs[k][0] === pairs[k - 1][0] + 1 && pairs[k][1] === pairs[k - 1][1] + 1) continue;
      const [x, y] = pairs[start], len = pairs[k - 1][0] - x + 1;
      problems.push(...compareWords(`appended +${(4 * x).toString(16)}`, ow.slice(x, x + len), nw.slice(y, y + len), appendOld + 4 * x, appendNew + 4 * y));
      start = k;
    }
  }
  const rtosOf = (file: Uint8Array) => { const d = new Firmware(file).decoded; const r = sectionsOf(d).find((x: any) => x.name === 'RTOS')!; return Buffer.from(d.subarray(r.offset, r.offset + r.size)); };
  const patOld = rtosOf(bo.file), patNew = rtosOf(bn.file);
  const siteNew = new Map<number, any>(mn.sites.map((s: any) => [s.address, s]));
  const used = new Set<number>();
  for (const s of mo.sites) {
    const t = T(s.address);
    const n = t === undefined ? undefined : siteNew.get(t);
    if (!n) { problems.push(`site ${s.address.toString(16)} (${s.reason}): no site at ${t?.toString(16)}`); continue; }
    used.add(t!);
    if (n.reason !== s.reason) problems.push(`site ${s.address.toString(16)}: reason "${s.reason}" vs "${n.reason}"`);
    const win = (img: Uint8Array, at: number) => Array.from({ length: 14 }, (_, k) => img.readUInt32LE(at - 0x18 + 4 * k - BASE));
    problems.push(...compareWords(`site ${s.address.toString(16)} (original code)`, win(origOld, s.address), win(origNew, t!), s.address - 0x18, t! - 0x18)
      .filter(x => /\+(1[4-9a-f]|18|1c)\b|\+(18|1c):/.test(x) || true).slice(0, 2));
    problems.push(...compareWords(`site ${s.address.toString(16)} (patched)`, win(patOld, s.address), win(patNew, t!), s.address - 0x18, t! - 0x18).slice(0, 2));
  }
  for (const s of mn.sites) if (!used.has(s.address)) problems.push(`new site ${s.address.toString(16)} (${s.reason}) without an old one`);
  if (mo.iconAddition.bytes !== mn.iconAddition.bytes) problems.push(`icon additions differ (${mo.iconAddition.bytes.length / 2} vs ${mn.iconAddition.bytes.length / 2} bytes)`);
  // Identical words that a mapping would have changed: data that looks like code or addresses (text,
  // glyphs, pixels), unless an address was not carried over; listed for review, not counted.
  const same = problems.filter(p => p.startsWith('SAME '));
  const real = problems.filter(p => !same.includes(p));
  console.log(`== ${name}: ${mo.sites.length} / ${mn.sites.length} sites, appended ${appendLength} bytes; ${real.length} differences, ${same.length} identical words to review`);
  for (const p of real.slice(0, 120)) console.log('   ' + p);
  if (process.env.SHOW_SAME) for (const p of same) console.log('   (same) ' + p);
  failures += real.length;
}
process.exitCode = failures ? 1 : 0;
