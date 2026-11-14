// SPDX-License-Identifier: GPL-2.0-only
/**
 * Compare a GR IV build on one firmware's program with the same build on its port (development
 * tool, not part of the program):
 *
 *   npx vite-node tools/port/compare_gr4.mts OLD.bin NEW.bin RUNS.json [recipe...]
 *
 * RUNS.json is `addrmap.py --runs` output. Both files are built through the app's engine with the
 * same recipe. In the official part of RTOS, every word the old build changed must be changed at the
 * mapped address of the new build, and the new build may change nothing else; the appended part
 * (GR Mod's code and data, at the end of each official RTOS) is compared word by word at the same
 * offset. Words are equal, or equal up to relocation: a branch to the mapped target, a literal or a
 * movw/movt pair holding the mapped address, an address in the appended part moved with it. ICONBIN
 * and the other sections must change the same way. Everything else is printed; the port's hand
 * edits are expected to show up there and nowhere else.
 */
import { readFileSync } from 'node:fs';
const { Engine } = await import('../../core/src/app/engine.ts');
const { Firmware, sectionsOf } = await import('../../core/src/fw/container.ts');
const { encodeShutdownPicture } = await import('../../core/src/fw/aspect/shutdown.ts');
const { testPresetRequests, testRatios } = await import('../../core/test/fw-helpers/test-firmware.ts');

const [oldPath, newPath, runsPath, ...wanted] = process.argv.slice(2);
const R = JSON.parse(readFileSync(runsPath, 'utf8'));
const runs: [number, number, number][] = R.runs.slice().sort((a: number[], b: number[]) => a[0] - b[0]);
const refs = new Map<number, number>(Object.entries(R.refs as Record<string, string>).map(([k, v]) => [parseInt(k, 16), parseInt(v, 16)]));
const overrides = new Map<number, number>(Object.entries(R.overrides as Record<string, string>).map(([k, v]) => [parseInt(k, 16), parseInt(v, 16)]));
const BASE = 0x53000000;
const oldEnd = BASE + R.oldLength, newEnd = BASE + R.newLength;
function T(a: number): number | undefined {
  if (overrides.has(a)) return overrides.get(a);
  if (a >= oldEnd && a < 0x55000000) return a - oldEnd + newEnd;
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
  if (a >= 0x55000000 && a < 0x56000000) return a;   // zero-initialised RAM and GR Mod's own words: same place (see the overrides)
  return undefined;
}
const isAddr = (v: number) => v >= 0x53000000 && v < 0x56000000;
const target = (w: number, at: number) => { let off = w & 0xffffff; if (off & 0x800000) off -= 0x1000000; return (at + 8 + off * 4) >>> 0; };
const isBranch = (w: number) => (w & 0x0e000000) === 0x0a000000 && (w >>> 28) !== 0xf;
const imm16 = (w: number) => ((w >>> 4) & 0xf000) | (w & 0xfff);
const isMovw = (w: number) => (w & 0x0ff00000) === 0x03000000 && (w >>> 28) !== 0xf;
const isMovt = (w: number) => (w & 0x0ff00000) === 0x03400000 && (w >>> 28) !== 0xf;

function compareWords(what: string, ow: number[], nw: number[], oAt: number, nAt: number): string[] {
  const out: string[] = [];
  const pairOk = new Set<number>();
  for (let i = 0; i < ow.length; i++) {
    if (!isMovw(ow[i]) || !isMovw(nw[i])) continue;
    const rd = (ow[i] >>> 12) & 15;
    for (let k = 1; k <= 6 && i + k < ow.length; k++) {
      if (isMovt(ow[i + k]) && ((ow[i + k] >>> 12) & 15) === rd && isMovt(nw[i + k]) && ((nw[i + k] >>> 12) & 15) === rd) {
        const vo = (imm16(ow[i + k]) << 16 | imm16(ow[i])) >>> 0, vn = (imm16(nw[i + k]) << 16 | imm16(nw[i])) >>> 0;
        if (isAddr(vo) ? T(vo) === vn : vo === vn) { pairOk.add(i); pairOk.add(i + k); }
        else out.push(`${what} +${(4 * i).toString(16)}: movw/movt ${vo.toString(16)} -> ${vn.toString(16)} (mapped ${T(vo)?.toString(16)})`);
        break;
      }
    }
  }
  for (let i = 0; i < ow.length; i++) {
    const v = ow[i], u = nw[i], a = oAt + 4 * i, b = nAt + 4 * i;
    if (pairOk.has(i) || v === u && !isBranch(v) && !isAddr(v)) continue;
    if (isBranch(v) && isBranch(u) && (v >>> 24) === (u >>> 24)) {
      const t = T(target(v, a));
      if (t === target(u, b)) continue;
      out.push(`${v === u ? 'SAME ' : ''}${what} +${(4 * i).toString(16)} (${a.toString(16)}): branch ${target(v, a).toString(16)} -> ${target(u, b).toString(16)} (mapped ${t?.toString(16)})`);
      continue;
    }
    if (isAddr(v)) {
      const t = T(v);
      if (t === u || v === u) { if (t !== u && t !== undefined) out.push(`SAME ${what} +${(4 * i).toString(16)} (${a.toString(16)}): address-like word ${v.toString(16)}`); continue; }
      out.push(`${what} +${(4 * i).toString(16)} (${a.toString(16)}): address ${v.toString(16)} -> ${u.toString(16)} (mapped ${t?.toString(16)})`);
      continue;
    }
    if (v !== u) out.push(`${what} +${(4 * i).toString(16)} (${a.toString(16)}): ${v.toString(16)} -> ${u.toString(16)}`);
  }
  return out;
}
const sec = (file: Uint8Array) => { const d = new Firmware(file).decoded; const m = new Map<string, Buffer>(); for (const s of sectionsOf(d)) m.set(s.name, Buffer.from(d.subarray(s.offset, s.offset + s.size))); return m; };
const words = (b: Buffer, from: number, to: number) => { const w: number[] = []; for (let i = from; i + 4 <= to; i += 4) w.push(b.readUInt32LE(i)); return w; };
const rawOld = new Uint8Array(readFileSync(oldPath)), rawNew = new Uint8Array(readFileSync(newPath));
const offOld = sec(rawOld), offNew = sec(rawNew);
const eOld = await Engine.open(rawOld), eNew = await Engine.open(rawNew);
const rgb = new Uint8Array(720 * 480 * 3).map((_, i) => (i * 7 + (i >> 11)) & 255);
const pics = (n: number) => Array.from({ length: n }, (_, k) => ({ id: 0x1007 + k, name: `Pic ${k + 1}`, jpeg: encodeShutdownPicture(rgb.map((v, i) => (v + k * 40 + (i % 3) * 10) & 255)) }));
const curve = Array.from({ length: 256 }, (_, i) => Math.min(16383, Math.round(16383 * Math.pow(i / 255, 0.8))));
const icon = new Uint8Array(1600 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 13) & 255));
const extra = (name: string, halation = false) => ({ name, matrixQ13: [9100, -600, -308, -300, 8800, -308, -100, -700, 8992], curves: [curve, curve, curve] as [number[], number[], number[]], icon, halation });
type Args = Parameters<InstanceType<typeof Engine>['buildFirmware']>;
const recipe = (e: InstanceType<typeof Engine>, name: string): Args => {
  const all = { monoUnlock: true, adjSoftFocus: true, dateStamp: true, brightAuto: true as const, directFlash: true, hdrGainMap: true, adjSlots: 8, exposurePreview: true,
    extraSlots: [extra('GR Mod 1', true), extra('GR Mod 2'), extra('GR Mod 3', true)], shutdownPictures: pics(2) };
  switch (name) {
    case 'full': return [testPresetRequests(e), testRatios(e), [], all];
    case 'plain': return [[], [], [], { guard: true, dateStamp: false, monoUnlock: true }];
    case 'presets': return [testPresetRequests(e), testRatios(e), [], {}];
    case 'twenty': return [[], [], [], { extraSlots: Array.from({ length: 20 }, (_, k) => extra(`S${k + 1}`, k % 3 === 0)), hdrGainMap: true }];
    default: { const k = name; return [[], [], [], { [k]: k === 'adjSlots' ? 8 : k === 'shutdownPictures' ? pics(3) : k === 'extraSlots' ? [extra('X', true)] : true } as never]; }
  }
};
let failures = 0;
const names = wanted.length ? wanted : ['monoUnlock', 'adjSoftFocus', 'dateStamp', 'brightAuto', 'directFlash', 'hdrGainMap', 'adjSlots', 'exposurePreview', 'extraSlots', 'shutdownPictures', 'presets', 'full', 'twenty'];
for (const name of names) {
  const bo = await eOld.buildFirmware(...recipe(eOld, name)), bn = await eNew.buildFirmware(...recipe(eNew, name));
  const so = sec(bo.file), sn = sec(bn.file);
  const problems: string[] = [];
  for (const [sname, o] of so) {
    const n = sn.get(sname)!;
    if (sname === 'RTOS') {
      const ol = offOld.get('RTOS')!.length, nl = offNew.get('RTOS')!.length;
      if (o.length - ol !== n.length - nl) problems.push(`appended RTOS part: ${o.length - ol} vs ${n.length - nl} bytes`);
      // official part: changed words
      const changedNew = new Set<number>();
      for (let i = 0; i < nl; i += 4) if (n.readUInt32LE(i) !== offNew.get('RTOS')!.readUInt32LE(i)) changedNew.add(BASE + i);
      for (let i = 0; i < ol; i += 4) {
        const v = o.readUInt32LE(i), orig = offOld.get('RTOS')!.readUInt32LE(i);
        if (v === orig) continue;
        const a = BASE + i, t = T(a);
        if (t === undefined) { problems.push(`changed word ${a.toString(16)}: not mapped`); continue; }
        changedNew.delete(t);
        // a window around the word, so that a movw is paired with its movt; only the word itself is judged
        const lo = Math.max(0, i - 24), hi = Math.min(ol, i + 28), d = t - BASE - i;
        if (lo + d < 0 || hi + d > nl) { problems.push(...compareWords(`patched ${a.toString(16)}`, [v], [n.readUInt32LE(t - BASE)], a, t)); continue; }
        problems.push(...compareWords(`patched ${a.toString(16)}`, words(o, lo, hi), words(n, lo + d, hi + d), BASE + lo, BASE + lo + d)
          .filter((x) => x.startsWith(`patched ${a.toString(16)} +${(i - lo).toString(16)} `) || x.startsWith(`patched ${a.toString(16)} +${(i - lo).toString(16)}:`)));
      }
      for (const t of changedNew) problems.push(`new build also changes ${t.toString(16)} (${offNew.get('RTOS')!.readUInt32LE(t - BASE).toString(16)} -> ${n.readUInt32LE(t - BASE).toString(16)})`);
      problems.push(...compareWords('appended', words(o, ol, o.length), words(n, nl, n.length), BASE + ol, BASE + nl));
    } else {
      const oo = offOld.get(sname)!, on = offNew.get(sname)!;
      const sameOfficial = oo.equals(on);
      if (sameOfficial ? !o.equals(n) : (o.equals(oo) !== n.equals(on))) problems.push(`${sname}: changed differently (${o.length} / ${n.length} bytes)`);
    }
  }
  // Identical words that a mapping would have changed: data that only looks like a branch or an
  // address (text, pixels, tables); listed with SHOW_SAME, not counted.
  const same = problems.filter((p) => p.startsWith('SAME ')), real = problems.filter((p) => !p.startsWith('SAME '));
  console.log(`== ${name}: ${bo.sha256.slice(0, 12)} / ${bn.sha256.slice(0, 12)}; checks ${Object.values(bn.checks).every((v) => v === true)}; ${real.length} differences, ${same.length} identical words`);
  for (const p of real.slice(0, 150)) console.log('   ' + p);
  if (process.env.SHOW_SAME) for (const p of same) console.log('   (same) ' + p);
  failures += real.length;
}
process.exitCode = failures ? 1 : 0;
