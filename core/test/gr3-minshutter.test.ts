// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III / IIIx: ISO Setting › Minimum Shutter Speed down to 30" (fw/gr3x/minshutter.ts, issue #25).
 * Needs the official files: GRMOD_GR3_FIRMWARE (2.10), GRMOD_GR3X_FIRMWARE (1.60),
 * GRMOD_GR3_220_FIRMWARE (2.20), GRMOD_GR3X_170_FIRMWARE (1.70); each missing one is skipped.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { Firmware, sectionsOf } from '../src/fw/container';

/** GR III 2.20 test 1 (camera-tested by the requester of issue #25): address, official word, new word. */
const TEST1_220: readonly (readonly [number, number, number])[] = [
  [0x531cf824, 0xe350001e, 0xe350002d], [0x531cf898, 0xe3013b38, 0xe3023d6c], [0x531cf89c, 0xe34533b4, 0xe34533d6],
  [0x531cf8a4, 0xe0832000, 0xe0432000], [0x531cf8a8, 0xe19350b0, 0xe11350b0], [0x531cfa28, 0xe30548b4, 0xe24cb004],
  [0x531cfa2c, 0xe3454405, 0xe24dd034], [0x531cfa30, 0xe24cb004, 0xe1a04000], [0x531cfa34, 0xe24dd02c, 0xe1a0100d],
  [0x531cfa38, 0xe5942000, 0xe3a02015], [0x531cfa3c, 0xe24b3038, 0xe3a0302e], [0x531cfa40, 0xe24b1019, 0xe4c12001],
  [0x531cfa44, 0xe3a0c000, 0xe2533001], [0x531cfa48, 0xe50b2018, 0x1afffffc], [0x531cfa4c, 0xe3a02015, 0xe5940160],
  [0x531cfa50, 0xe50bc038, 0xe1a0100d], [0x531cfa54, 0xe50bc034, 0xe3a0202e], [0x531cfa58, 0xe50bc030, 0xe3a0303a],
  [0x531cfa5c, 0xe50bc02c, 0xeb071327], [0x531cfa60, 0xe50bc028, 0xe24bd010], [0x531cfa64, 0xe50bc024, 0xe89da810],
  [0x531cfa68, 0xe50bc020, 0xe320f000], [0x531cfa6c, 0xe14bc1bc, 0xe320f000], [0x531cfa70, 0xe54bc01a, 0xe320f000],
  [0x531cfa74, 0xe4c32001, 0xe320f000], [0x531cfa78, 0xe1530001, 0xe320f000], [0x531cfa7c, 0x1afffffc, 0xe320f000],
  [0x531cfa80, 0xe5900160, 0xe320f000], [0x531cfa84, 0xe3a0201f, 0xe320f000], [0x531cfa88, 0xe3a0303a, 0xe320f000],
  [0x531cfa8c, 0xe24b1038, 0xe320f000], [0x531cfa90, 0xeb07131a, 0xe320f000], [0x531cfa94, 0xe51b2018, 0xe320f000],
  [0x531cfa98, 0xe5943000, 0xe320f000], [0x531cfa9c, 0xe1520003, 0xe320f000], [0x531cfaa0, 0x1a000001, 0xe320f000],
  [0x531cfaa4, 0xe24bd010, 0xe320f000], [0x531cfaa8, 0xe89da810, 0xe320f000], [0x531cfac0, 0xe3014b38, 0xe3024d6c],
  [0x531cfacc, 0xe34543b4, 0xe34543d6], [0x531cfb18, 0xe355001f, 0xe355002e], [0x531cfb1c, 0xe2844004, 0xe2444004],
  [0x531cfb68, 0xe3015b38, 0xe3025d6c], [0x531cfb88, 0xe34553b4, 0xe34553d6], [0x531cfbc0, 0xe2855004, 0xe2455004],
  [0x531cfbc8, 0xe354001f, 0xe354002e], [0x531cfc04, 0xe2855004, 0xe2455004], [0x531cfc1c, 0xe354001f, 0xe354002e],
];
const FILES = [
  ['GR III 2.10', process.env.GRMOD_GR3_FIRMWARE, false],
  ['GR IIIx 1.60', process.env.GRMOD_GR3X_FIRMWARE, false],
  ['GR III 2.20', process.env.GRMOD_GR3_220_FIRMWARE, true],
  ['GR IIIx 1.70', process.env.GRMOD_GR3X_170_FIRMWARE, true],
] as const;
const RATIOS = [{ ratio: '2.39:1', name: 'Scope' }];
const rtosOf = (file: Uint8Array) => {
  const d = new Firmware(file).decoded; const r = sectionsOf(d).find(s => s.name === 'RTOS')!;
  return new DataView(d.buffer, d.byteOffset + r.offset, r.size);
};

for (const [name, path, is220] of FILES) {
  describe.skipIf(!path)(`${name}: Minimum Shutter Speed to 30"`, () => {
    it('changes exactly the list\'s 48 words, and the reopened build says so', async () => {
      const raw = new Uint8Array(readFileSync(path!));
      const engine = await Engine.open(raw);
      expect(engine.info.features.minShutter).toBe(true);
      const off = await engine.buildFirmware([], RATIOS, [], { dateStamp: true });
      const on = await engine.buildFirmware([], RATIOS, [], { dateStamp: true, minShutter: true });
      expect(on.features).toMatchObject({ minShutter: true });
      const official = rtosOf(raw), a = rtosOf(off.file), b = rtosOf(on.file);
      const changed: [number, number, number][] = [];
      for (let i = 0; i < official.byteLength; i += 4)
        if (a.getUint32(i, true) !== b.getUint32(i, true)) changed.push([0x53000000 + i, a.getUint32(i, true), b.getUint32(i, true)]);
      expect(changed.length).toBe(48);
      // Every changed word was the official one in the build without it.
      for (const [at, was] of changed) expect(was).toBe(official.getUint32(at - 0x53000000, true));
      // On 2.20 / 1.70: word for word the camera-tested test 1.
      if (is220) expect(changed).toEqual(TEST1_220.map(x => [...x]));
      else expect(changed.every(([at]) => at >= 0x531cf710 && at < 0x531cfb48)).toBe(true);
      const seenOn = await engine.inspect(on.file), seenOff = await engine.inspect(off.file);
      expect(seenOn).toMatchObject({ kind: 'modified', verified: true, minShutter: true, dateStamp: true });
      expect(seenOff).toMatchObject({ kind: 'modified', verified: true, dateStamp: true });
      expect(seenOff.minShutter).toBeUndefined();
    }, 300000);
  });
}
