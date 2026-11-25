// SPDX-License-Identifier: GPL-2.0-only
/**
 * Subject recognition for photo AF (`gr4v120/aspect/subjectaf.ts`, GR IV 1.20 and 1.21).
 * Needs GRMOD_GR4_120_FIRMWARE (or testdata/private/official120.bin) and GRMOD_GR4_121_FIRMWARE (or
 * testdata/private/official121.bin); the "not offered" case testdata/private/official.bin (1.11).
 * The module and the adapters are checked by tools/gr4v120/afplain/evaluation (test_plain_units.py: the module inside a
 * built RTOS; native_plain_probe.py: the camera's own half-press, live view, AF loop and getter round the hooks;
 * face_follow_rule_probe.py: the three words of the face rule in the camera's settings recompute).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src';
import * as code120 from '../src/fw/gr4v120/aspect/subjectaf-code';
import * as code121 from '../src/fw/gr4v121/aspect/subjectaf-code';
import { SUBJECTAF_MODEL, SUBJECTAF_MODEL_LENGTH, SUBJECTAF_MODEL_SHA256 } from '../src/fw/gr4v120/aspect/subjectaf-model-code';
import { createHash } from 'node:crypto';

const P = fileURLToPath(new URL('../testdata/private/', import.meta.url));
const file120 = process.env.GRMOD_GR4_120_FIRMWARE || P + 'official120.bin';
const file111 = P + 'official.bin';
const file121 = process.env.GRMOD_GR4_121_FIRMWARE || P + 'official121.bin';

type Hook = [op: number, site: number, kind: 'call' | 'entry' | 'branch' | 'vtable', word: number, target: number];
// Per release: the eight hooks (op, site, what is there: a bl / b to target, the first word of a function, a vtable slot),
// the face rule's three words, the heap's movw; the module compiled for the release.
const releases: { version: string; path: string; HOOKS: Hook[]; FACE: number; HEAP: number; code: { SUBJECTAF_CODE: string; SUBJECTAF_CODE_LENGTH: number } }[] = [
  { version: '1.20', path: file120, FACE: 0x532adc20, HEAP: 0x53ad3684, code: code120, HOOKS: [
    [1, 0x533acd04, 'call', 0, 0x5325e104], [2, 0x5365cba8, 'call', 0, 0x5366bc80], [5, 0x53831044, 'entry', 0xe1a0c00d, 0x53831048],
    [6, 0x538299f4, 'entry', 0xe1a0c00d, 0x538299f8], [7, 0x53fddf34, 'vtable', 0, 0x53835ac0], [8, 0x5360ebd0, 'entry', 0xe590c02c, 0x5360ebd4],
    [12, 0x53626410, 'entry', 0xe3a06000, 0x53626414], [26, 0x533b060c, 'branch', 0, 0x533b0530]] },
  { version: '1.21', path: file121, FACE: 0x532ae470, HEAP: 0x53ad4c4c, code: code121, HOOKS: [
    [1, 0x533ad5b4, 'call', 0, 0x5325e950], [2, 0x5365d4e8, 'call', 0, 0x5366c5c0], [5, 0x53831f0c, 'entry', 0xe1a0c00d, 0x53831f10],
    [6, 0x5382a8bc, 'entry', 0xe1a0c00d, 0x5382a8c0], [7, 0x53fdf6bc, 'vtable', 0, 0x53836988], [8, 0x5360f510, 'entry', 0xe590c02c, 0x5360f514],
    [12, 0x53626d50, 'entry', 0xe3a06000, 0x53626d54], [26, 0x533b0ebc, 'branch', 0, 0x533b0de0]] },
];
const MAGIC = 0x31464741, STATE = 0x55839080, FLAGS = 15, ZERO_FILL_END = 0x53000460, HEAP_END = 0x55839280;
const FACE_BEFORE = [0xe3500001, 0x03a02000, 0x13a02002], FACE_AFTER = [0xe3100001, 0x13a02000, 0x03a02002];

function rtos(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded, s = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.slice(s.offset, s.offset + s.size);
}
const word = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at - 0x53000000, true);
const branchTarget = (at: number, w: number) => at + 8 + (((w & 0xffffff) << 8) >> 6);
const findWord = (b: Uint8Array, v: number, from: number) => { for (let i = from; i + 4 <= b.length; i += 4) if (word(b, 0x53000000 + i) === v) return 0x53000000 + i; return -1; };
const recordStart = (v: Uint8Array) => v.length - 16 - new DataView(v.buffer, v.byteOffset, v.byteLength).getUint32(v.length - 16, true);
const rgb = (v: number) => new Uint8Array(720 * 480 * 3).fill(v);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

for (const { version, path, HOOKS, FACE, HEAP, code } of releases) describe.skipIf(!existsSync(path))(`subject recognition ${version}`, () => {
  const raw = existsSync(path) ? new Uint8Array(readFileSync(path)) : new Uint8Array();
  const module = Uint8Array.from(Buffer.from(code.SUBJECTAF_CODE, 'base64'));
  const model = Uint8Array.from(Buffer.from(SUBJECTAF_MODEL, 'base64'));
  const recipes: [string, (e: Engine) => BuildOptions][] = [
    ['alone', () => ({})],
    ['with the other additions and power-off pictures', (e) => ({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, adjSoftFocus: true, exposurePreview: true, brightAuto: 'balanced',
      shadowLearn: true, filmGrain: true, flashTtl: true, batteryPercent: true, videoAf: true, awbLearn: true, constantLight: true, sensorShift: true, movie4k: true, movieSr: true, movieExposure: true, distanceFeet: true,
      shutdownPictures: [{ id: 0x2001, name: 'Test', jpeg: e.encodeMenuPicture(rgb(90)) }] } as BuildOptions)],
  ];
  for (const [name, options] of recipes) {
    it(`${name}: eight hooks to adapters appended last, the face rule, the heap 512 bytes later, the module, model and context; verified and read back`, async () => {
      const e = await Engine.open(raw);
      expect(e.info.features.subjectAf).toBe(true);
      const o = options(e);
      const plain = Object.keys(o).length ? await e.buildFirmware([], [], [], o) : null;
      const on = await e.buildFirmware([], [], [], { ...o, subjectAf: true });
      expect(Object.values(on.checks).every((v) => v === true)).toBe(true);
      const a = rtos(new Uint8Array(raw)), b = rtos(on.file);
      // The official words the hooks replace, and where they go now.
      for (const [, site, kind, w, target] of HOOKS) {
        if (kind === 'vtable') expect(word(a, site)).toBe(target);
        else if (kind === 'entry') expect(word(a, site)).toBe(w);
        else { expect(word(a, site) >>> 24).toBe(kind === 'call' ? 0xeb : 0xea); expect(branchTarget(site, word(a, site))).toBe(target); }
        const stub = kind === 'vtable' ? word(b, site) : branchTarget(site, word(b, site));
        if (kind !== 'vtable') expect(word(b, site) >>> 24).toBe(kind === 'call' ? 0xeb : 0xea);
        expect(stub - 0x53000000).toBeGreaterThanOrEqual(a.length);
        expect(word(b, stub)).toBe(0xe92d5fff); // push {r0-r12, lr}: every register kept
      }
      expect(FACE_BEFORE.map((_, i) => word(a, FACE + 4 * i))).toEqual(FACE_BEFORE);
      expect(FACE_AFTER.map((_, i) => word(b, FACE + 4 * i))).toEqual(FACE_AFTER);
      expect([word(a, HEAP), word(b, HEAP), word(b, HEAP + 4)]).toEqual([0xe3093080, 0xe3093280, 0xe3453583]);
      expect(word(b, ZERO_FILL_END)).toBe(HEAP_END);
      // The module (this release's compile), the model, the context.
      expect(module.length).toBe(code.SUBJECTAF_CODE_LENGTH);
      expect([model.length, sha(model)]).toEqual([SUBJECTAF_MODEL_LENGTH, SUBJECTAF_MODEL_SHA256]);
      const at = Buffer.from(b).indexOf(Buffer.from(module));
      expect(at).toBeGreaterThanOrEqual(a.length);
      const modelAt = Math.ceil((at + module.length) / 16) * 16, ctx = Math.ceil((modelAt + model.length) / 16) * 16;
      expect(Buffer.from(b.slice(modelAt, modelAt + model.length)).equals(Buffer.from(model))).toBe(true);
      const c = 0x53000000 + ctx;
      expect([word(b, c), word(b, c + 4), word(b, c + 8), word(b, c + 12), word(b, c + 16), word(b, c + 60)]).toEqual([MAGIC, 1, STATE, 0x53000000 + modelAt, model.length, FLAGS]);
      expect(word(b, c + 56)).toBe(c + 80); // the native getter trampoline: the replaced word, then back
      expect(word(b, c + 80)).toBe(0xe590c02c);
      expect(branchTarget(c + 84, word(b, c + 84))).toBe(HOOKS.find((h) => h[0] === 8)![4]);
      expect(findWord(b, MAGIC, a.length)).toBe(c);
      if (plain) {
        // Within the official image, against the same build without it, only the declared words differ.
        const own = new Set([...HOOKS.map((h) => h[1]), FACE, FACE + 4, FACE + 8, HEAP, ZERO_FILL_END]);
        const q = rtos(plain.file);
        const changed: string[] = [];
        for (let i = 0; i < a.length - 16; i += 4) if (!own.has(0x53000000 + i) && word(q, 0x53000000 + i) !== word(b, 0x53000000 + i)) changed.push((0x53000000 + i).toString(16));
        expect(changed).toEqual([]);
        // Everything the other additions build stays where it was: subject recognition is appended after them.
        const end = recordStart(q);
        let first = end;
        for (let i = a.length; i < end; i += 4) {
          const x = 0x53000000 + i;
          if (word(q, x) === word(b, x)) continue;
          expect(word(q, x)).toBe(0);
          first = Math.min(first, i);
        }
        for (let i = first; i < end; i += 4) expect(word(q, 0x53000000 + i)).toBe(0);
        expect(at).toBeGreaterThanOrEqual(first);
      }
      const summary = await e.inspect(on.file);
      expect(summary.verified).toBe(true);
      expect(summary.subjectAf).toBe(true);
      if (plain) expect(summary).toMatchObject({ dateStamp: true, directFlash: true, hdrGainMap: true, adjSlots: 8, brightAuto: 'balanced', exposurePreview: true, shadowLearn: true, filmGrain: true, flashTtl: true,
        batteryPercent: true, videoAf: true, awbLearn: true, constantLight: true, sensorShift: true, movie4k: true, movieSr: true, movieExposure: true, distanceFeet: true });
    }, 240000);
  }
  it('omitted and false build the same bytes, and read back without it', async () => {
    const e = await Engine.open(raw);
    const a = await e.buildFirmware([], [], [], { dateStamp: true });
    const b = await e.buildFirmware([], [], [], { dateStamp: true, subjectAf: false });
    expect(Buffer.from(a.file).equals(Buffer.from(b.file))).toBe(true);
    expect((await e.inspect(b.file)).subjectAf).toBeUndefined();
  }, 60000);
  it('refuses a non-boolean switch', async () => {
    const e = await Engine.open(raw);
    await expect(e.buildFirmware([], [], [], { subjectAf: 1 } as unknown as BuildOptions)).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});

describe('subject recognition: where it is not offered', () => {
  it.skipIf(!existsSync(file111))('GR IV 1.11: not offered, and refused', async () => {
    const e = await Engine.open(new Uint8Array(readFileSync(file111)));
    expect(e.info.features.subjectAf).toBeUndefined();
    await expect(e.buildFirmware([], [], [], { dateStamp: true, subjectAf: true })).rejects.toMatchObject({ code: 'bad-edit' });
  }, 60000);
});
