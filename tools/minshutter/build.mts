// GR III 2.20 test firmware: Minimum Shutter Speed down to 30 s (sites.json from sites.py / patchimg.py).
import { readFileSync, writeFileSync } from 'node:fs';
import { buildGrown, FRAME_SIZE, sectionsOf, sha256Hex, sum32 } from '/home/claude/maxwooow/grmod/core/src/fw/container';
import { selfCheckGrown } from '/home/claude/maxwooow/grmod/core/src/fw/selfcheck';
import { openGr3xOfficial } from '/home/claude/maxwooow/grmod/core/src/fw/gr3x170/profile';
const [, , input, sitesFile, output, tag] = process.argv;
const raw = new Uint8Array(readFileSync(input));
const { fw, decoded, profile } = await openGr3xOfficial(raw);
const sections = sectionsOf(decoded);
const rtos = sections.find(s => s.name === 'RTOS')!;
const sites: { address: number; expected: string; replacement: string }[] = JSON.parse(readFileSync(sitesFile, 'utf8')).sites;
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, b => parseInt(b, 16));
const record = new TextEncoder().encode(`${profile.tag}-${tag}-HARDWARE-UNTESTED\0`);
const growth = Math.ceil((record.length + 4) / FRAME_SIZE) * FRAME_SIZE;
const rtosEnd = rtos.offset + rtos.size;
const out = new Uint8Array(decoded.length + growth);
out.set(decoded.subarray(0, rtosEnd));
out.set(decoded.subarray(rtosEnd), rtosEnd + growth);
const view = new DataView(out.buffer);
view.setUint32(rtos.offset - 4, rtos.size + growth, true);
const ranges: { what: string; offset: number; length: number }[] = [];
for (const s of sites) {
  const offset = rtos.offset + s.address - profile.rtosBase;
  const old = unhex(s.expected), next = unhex(s.replacement);
  if (old.some((b, i) => decoded[offset + i] !== b)) throw new Error('guard ' + s.address.toString(16));
  out.set(next, offset);
  ranges.push({ what: 'Minimum Shutter Speed list', offset, length: 4 });
}
out.set(record, rtosEnd + growth - record.length - 4);
view.setUint32(rtosEnd + growth - 4, (-sum32(out)) >>> 0, true);
ranges.push({ what: 'RTOS section length', offset: rtos.offset - 4, length: 4 }, { what: 'appended record and checksum', offset: rtosEnd, length: growth });
const built = buildGrown(fw, out, [{ at: rtosEnd, length: growth }]);
const checks = selfCheckGrown(raw, built.out, ranges, out);
const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
if (bad.length) throw new Error('self-check failed: ' + bad.join(', '));
writeFileSync(output, built.out);
console.log(JSON.stringify({ profile: profile.id, sites: sites.length, growth, checks, out: output, bytes: built.out.length, sha256: await sha256Hex(built.out), decodedSha256: await sha256Hex(out) }, null, 1));
