// SPDX-License-Identifier: GPL-2.0-only
/**
 * The aspect-ratio builder against the reference implementation (DoYitNow/gr-custom-tool, commit
 * 0c15c8f) run on the same official firmware: tools/aspect/gen_oracle.py recorded, for every
 * possible screen geometry (one ratio each) and for random lists of up to 8 ratios, either that
 * the reference refuses the configuration or the SHA-256 of what it changed. Here the same
 * configurations are built and must give the same refusals and the same bytes.
 *
 * Needs the official firmware in testdata/private; skipped without it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { FirmwareError, ICONBIN_LENGTH, ICONBIN_OFFSET, RTOS_LENGTH, RTOS_OFFSET, openOfficial } from '../src/fw';
import { installRatios, parseRatio, planRatios } from '../src/fw/aspect';
import type { AspectResult } from '../src/fw/aspect';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFFICIAL = join(HERE, '..', 'testdata', 'private', 'official.bin');
const ORACLE = join(HERE, 'fw-helpers', 'aspect-oracle.json');
const BLOBS = join(HERE, '..', '..', 'tools', 'aspect', 'out', 'blobs');
const have = existsSync(OFFICIAL) && existsSync(ORACLE);

interface Row {
  key: string; ratios: [string, string][]; ok: boolean; error?: string; end?: number; patched_words?: number; patched_sha256?: string;
  appended_sha256?: string; icon_growth?: number; icon_ids?: number[]; icon_offsets?: number[]; sizes?: number[][];
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const FACTORY = ['3:2', '4:3', '16:9', '1:1'].map(parseRatio);

/** Words that differ inside the official part: packed {u32 offset, u32 value}, ascending. Every other byte must be equal. */
function patchedWords(official: Uint8Array, out: Uint8Array, r: AspectResult): Uint8Array {
  const offsets = [...new Set(r.words.map((w) => w.address - 0x53000000))].sort((a, b) => a - b);
  const o = Buffer.from(official.buffer, official.byteOffset, official.length);
  const n = Buffer.from(out.buffer, out.byteOffset, out.length);
  let prev = 0;
  const packed: number[] = [];
  for (const off of [...offsets, official.length]) {
    if (o.compare(n, prev, off, prev, off) !== 0) throw new Error(`unrecorded change between 0x${prev.toString(16)} and 0x${off.toString(16)}`);
    if (off < official.length) {
      const before = o.readUInt32LE(off);
      const after = n.readUInt32LE(off);
      if (before !== after) packed.push(off, after);
    }
    prev = off + 4;
  }
  return new Uint8Array(new Uint32Array(packed).buffer);
}

function explain(key: string, out: Uint8Array, packed: Uint8Array): string {
  const file = join(BLOBS, key + '.bin');
  if (!existsSync(file)) return '';
  const raw = inflateSync(readFileSync(file));
  const n = raw.readUInt32LE(0);
  const refPatch = raw.subarray(4, 4 + n);
  const refApp = raw.subarray(4 + n);
  const mine = Buffer.from(packed);
  for (let i = 0; i < Math.max(refPatch.length, mine.length); i += 8) {
    const a = i < refPatch.length ? [refPatch.readUInt32LE(i), refPatch.readUInt32LE(i + 4)] : [-1, -1];
    const b = i < mine.length ? [mine.readUInt32LE(i), mine.readUInt32LE(i + 4)] : [-1, -1];
    if (a[0] !== b[0] || a[1] !== b[1]) return `patched word #${i / 8}: reference ${a.map((v) => v.toString(16))}, here ${b.map((v) => v.toString(16))}`;
  }
  const app = out.subarray(RTOS_LENGTH);
  for (let i = 0; i < Math.max(app.length, refApp.length); i++) {
    if (app[i] !== refApp[i]) {
      const at = 0x53000000 + RTOS_LENGTH + i;
      const hex = (b: Uint8Array): string => Buffer.from(b.subarray(Math.max(0, i - 8), i + 24)).toString('hex');
      return `appended byte at 0x${at.toString(16)} (lengths ${app.length} / reference ${refApp.length})\n  ref  ${hex(refApp)}\n  here ${hex(app)}`;
    }
  }
  return 'no difference found against the saved reference bytes';
}

describe.skipIf(!have)('aspect: byte-identical to the reference implementation', () => {
  const rows = have ? (JSON.parse(readFileSync(ORACLE, 'utf8')) as Row[]) : [];
  let rtos: Uint8Array;
  let iconbin: Uint8Array;

  it('loads the official firmware', async () => {
    const { decoded } = await openOfficial(new Uint8Array(readFileSync(OFFICIAL)));
    rtos = decoded.slice(RTOS_OFFSET, RTOS_OFFSET + RTOS_LENGTH);
    iconbin = decoded.slice(ICONBIN_OFFSET, ICONBIN_OFFSET + ICONBIN_LENGTH);
    expect(rows.length).toBeGreaterThan(0);
  });

  it(`same result on ${rows.length} configurations`, () => {
    const problems: string[] = [];
    let accepted = 0;
    let refused = 0;
    let skipped = 0;
    for (const row of rows) {
      const specs = row.ratios.map(([name, ratio]) => ({ name, ratio }));
      if (specs.some((s) => FACTORY.some((f) => f.eq(parseRatio(s.ratio))))) {
        // The reference clones a factory ratio's geometry; here that request is refused on purpose.
        expect(() => planRatios(specs)).toThrowError(FirmwareError);
        skipped++;
        continue;
      }
      let result: AspectResult | null = null;
      let error = '';
      try {
        result = installRatios(rtos, iconbin, planRatios(specs));
      } catch (e) {
        if (!(e instanceof FirmwareError)) throw e;
        error = e.message;
      }
      if (!row.ok) {
        if (result) problems.push(`${row.key}: the reference refuses this (${row.error}), built here`);
        else refused++;
        continue;
      }
      if (!result) {
        problems.push(`${row.key}: the reference builds this, refused here (${error})`);
        continue;
      }
      const packed = patchedWords(rtos, result.rtos, result);
      const bad =
        result.rtos.length !== row.end ? `length 0x${result.rtos.length.toString(16)}, reference 0x${row.end!.toString(16)}`
        : sha(packed) !== row.patched_sha256 ? 'patched words differ'
        : sha(result.rtos.subarray(RTOS_LENGTH)) !== row.appended_sha256 ? 'appended area differs'
        : result.iconbin.length - iconbin.length !== row.icon_growth ? 'icon growth differs'
        : '';
      if (bad) problems.push(`${row.key} ${JSON.stringify(row.ratios)}: ${bad}; ${explain(row.key, result.rtos, packed)}`);
      else accepted++;
    }
    expect(problems.slice(0, 6)).toEqual([]);
    console.log(`aspect oracle: ${accepted} identical, ${refused} refused by both, ${skipped} factory-ratio requests skipped`);
  });
});
