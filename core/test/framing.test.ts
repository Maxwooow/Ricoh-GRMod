// SPDX-License-Identifier: GPL-2.0-only
/**
 * Framing guides (GR IV 1.20 and 1.21, `src/fw/gr4v120/aspect/framing.ts`): the model, its compilation into the
 * list the camera interprets, the build record and the menu names. Builds need the official files
 * (GRMOD_GR4_120_FIRMWARE, GRMOD_GR4_121_FIRMWARE). What the camera draws is checked in an emulator by
 * `tools/gr4v120/framing/check.py` (and its 1.21 copy) against `framingRects`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import {
  CAMERA_PRESETS, compilePreset, decodeFramingGuides, defaultFramingGuides, encodeFramingGuides, evaluateBoxes, framingProblem, framingRects,
  framingValues, isCameraPreset, presetList,
} from '../src/fw/gr4v120/aspect/framing';
import type { FramingGuides } from '../src/fw/gr4v120/aspect/framing';
import { FRAMING_GRID_NAMES } from '../src/fw/gr4v120/aspect/viewmenu';
import { readExtensionFeatures } from '../src/fw/gr4v120/aspect/package';
import * as names120 from '../src/fw/gr4v120/names';

const files = [['1.20', process.env.GRMOD_GR4_120_FIRMWARE], ['1.21', process.env.GRMOD_GR4_121_FIRMWARE]].filter(([, f]) => !!f && existsSync(f)) as [string, string][];

const rtosOf = (file: Uint8Array): Uint8Array => {
  const d = new fw.Firmware(file).decoded;
  const r = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
  return d.subarray(r.offset, r.offset + r.size);
};

/** Frame A 2.39:1 with a mask and thirds in it, a red centre cross; golden section, a moved 1:1, an inset dashed frame, a diagonal, a 4:5 in the 1:1. */
function sample(): FramingGuides {
  const g = defaultFramingGuides();
  g.presets[0].elements = [
    { kind: 'frame', num: 239, den: 100, scale: 100, x: 0, y: 0, box: 0, style: 'corners', corner: 12, mask: 3, colour: 1, width: 3 },
    { kind: 'grid', cols: 3, rows: 3, box: 1, dash: 'solid', colour: 2, width: 2 },
    { kind: 'centre', mark: 'cross', size: 28, box: 0, colour: 4, width: 2 },
  ];
  g.presets[1].elements = [
    { kind: 'golden', box: 0, dash: 'solid', colour: 5, width: 2 },
    { kind: 'frame', num: 1, den: 1, scale: 90, x: 10, y: -5, box: 0, style: 'box', corner: 15, mask: null, colour: 6, width: 2 },
    // a safe area: the picture inset by the same width on all four sides
    { kind: 'frame', scale: 90, x: 0, y: 0, box: 0, style: 'dashed', corner: 15, mask: null, colour: 7, width: 2 },
    { kind: 'line', axis: 'h', at: 5000, box: 0, dash: 'dashed', colour: 1, width: 1 },
    { kind: 'centre', mark: 'dot', size: 8, box: 1, colour: 4, width: 1 },
    { kind: 'diagonals', down: true, up: false, colour: 5, width: 1 },
    // a 4:5 frame in frame A (the 1:1): a box fitted into a box
    { kind: 'frame', num: 4, den: 5, scale: 80, x: 0, y: 0, box: 1, style: 'corners', corner: 15, mask: null, colour: 2, width: 2 },
  ];
  return g;
}

describe('Framing guides: the model', () => {
  it('the defaults are the camera’s own styles and have no value of their own', () => {
    const g = defaultFramingGuides();
    expect(framingProblem(g)).toBeNull();
    expect(isCameraPreset(g, 0)).toBe(true);
    expect(isCameraPreset(g, 1)).toBe(true);
    expect(framingValues(g)).toEqual([]);
    // the camera's colour changed: the same lines, but not the camera's grid any more
    g.palette[0] = { r: 255, g: 255, b: 255, a: 255 };
    expect(framingValues(g)).toEqual(['custom3', 'custom4']);
  });

  it('the camera’s 3x3 as rectangles: the thirds, 2 px, centred where the camera draws them (to a pixel)', () => {
    const rects = framingRects(compilePreset(CAMERA_PRESETS[0]), { x: 0, y: 0, w: 720, h: 480 });
    expect(rects.map((r) => [r.x, r.y, r.w, r.h])).toEqual([[0, 159, 720, 2], [0, 319, 720, 2], [239, 0, 2, 480], [479, 0, 2, 480]]);
  });

  it('a frame line is fitted to the picture: full width on 3:2, full height when the picture is narrower', () => {
    const c = compilePreset(sample().presets[0]);
    expect(evaluateBoxes(c.boxes, { x: 0, y: 0, w: 720, h: 480 })[1]).toEqual({ x: 0, y: 89, w: 720, h: 301 });
    // the camera's 1:1 picture: 480 wide, so the 2.39 frame is 480 x 201
    expect(evaluateBoxes(c.boxes, { x: 120, y: 0, w: 480, h: 480 })[1]).toEqual({ x: 120, y: 139, w: 480, h: 201 });
    // a moved, scaled 1:1 frame (preset 2): 90 % of 480, 10 % of the width to the right, 5 % of the height up
    const d = compilePreset(sample().presets[1]);
    expect(evaluateBoxes(d.boxes, { x: 0, y: 0, w: 720, h: 480 })[1]).toEqual({ x: 72 + 144, y: -24 + 24, w: 432, h: 432 });
  });

  it('a frame in a frame; a frame without a ratio is its box inset by the same width on all four sides', () => {
    const one = compilePreset({ elements: [{ kind: 'frame', num: 4, den: 5, scale: 90, x: 0, y: 0, box: 0, style: 'box', corner: 15, mask: null, colour: 0, width: 2 }] });
    expect(evaluateBoxes(one.boxes, { x: 0, y: 0, w: 720, h: 480 })[1]).toEqual({ x: 187, y: 24, w: 346, h: 432 });
    const d = compilePreset(sample().presets[1]);
    expect(d.boxes.map((b) => b.parent)).toEqual([0, 0, 1]);
    // in frame A (216, 0, 432, 432): 80 % of its height, 4:5
    expect(evaluateBoxes(d.boxes, { x: 0, y: 0, w: 720, h: 480 })[3]).toEqual({ x: 216 + ((432 - 277) >> 1), y: 43, w: 277, h: 346 });
    // without a ratio: a share of the shorter side on every side (89 % of a 65:24 window), and moved like any frame
    const inset = (x: number) => compilePreset({ elements: [{ kind: 'frame', scale: 89, x, y: 0, box: 0, style: 'box', corner: 15, mask: null, colour: 0, width: 2 }] });
    const m = Math.round((266 * 0.11) / 2);
    expect(evaluateBoxes(inset(0).boxes, { x: 0, y: 107, w: 720, h: 266 })[1]).toEqual({ x: m, y: 107 + m, w: 720 - 2 * m, h: 266 - 2 * m });
    expect(evaluateBoxes(inset(10).boxes, { x: 0, y: 107, w: 720, h: 266 })[1].x).toBe(m + 72);
    // a frame can only be in an earlier one
    const g = sample();
    (g.presets[1].elements[1] as { box: number }).box = 2;
    expect(framingProblem(g)).toMatch(/earlier frame/);
  });

  it('records of version 1 and 2 (safe areas apart from frame lines) read as frames', () => {
    // version 1: one safe area of 90 % in the picture
    const v1 = Uint8Array.from([1, 1, 0, 0, 0, 128, 1, 6, 0, 2, 90, 0, 0, 0]);
    expect(decodeFramingGuides(v1)?.presets[0].elements).toEqual([{ kind: 'frame', scale: 90, x: 0, y: 0, box: 0, style: 'box', corner: 15, mask: null, colour: 0, width: 2 }]);
    // version 2: a safe area 4:5 at 80 % in the line before it, a grid in that line: frames A and B, the grid stays in A
    const v2 = Uint8Array.from([2, 1, 0, 0, 0, 128, 3, 6, 0, 2, 80, 1, 1, 4, 0, 5, 0, 7, 0, 2, 1, 0, 1, 0, 90, 0, 0, 0, 15, 255, 2, 0, 2, 3, 3, 1, 0, 0]);
    // the safe area comes before its line: it cannot be in it, so it goes into the picture
    expect(decodeFramingGuides(v2)?.presets[0].elements).toEqual([
      { kind: 'frame', num: 4, den: 5, scale: 80, x: 0, y: 0, box: 0, style: 'corners', corner: 15, mask: null, colour: 0, width: 2 },
      { kind: 'frame', num: 1, den: 1, scale: 90, x: 0, y: 0, box: 0, style: 'box', corner: 15, mask: null, colour: 0, width: 2 },
      { kind: 'grid', cols: 3, rows: 3, box: 2, dash: 'solid', colour: 0, width: 2 },
    ]);
  });

  it('the mask covers the picture outside the frame line, in four bands (empty ones not drawn)', () => {
    const rects = framingRects(compilePreset(sample().presets[0]), { x: 0, y: 0, w: 720, h: 480 });
    expect(rects.slice(0, 2).map((r) => [r.x, r.y, r.w, r.h, r.colour])).toEqual([[0, 0, 720, 89, 3], [0, 390, 720, 90, 3]]);
  });

  it('rejects what the camera cannot draw', () => {
    const g = sample();
    for (let i = 0; i < 7; i++) g.presets[0].elements.push({ kind: 'frame', num: 4, den: 3, scale: 100 - i, x: 0, y: 0, box: 0, style: 'box', corner: 15, mask: null, colour: 0, width: 2 });
    expect(framingProblem(g)).toMatch(/more than 7 frames/);
    const h = sample();
    h.presets[1].elements[0] = { kind: 'grid', cols: 3, rows: 3, box: 4, dash: 'solid', colour: 0, width: 2 };
    expect(framingProblem(h)).toMatch(/grid/);
    const k = sample();
    k.palette = k.palette.slice(0, 3);
    expect(framingProblem(k)).toMatch(/colour/);
    const m = sample();
    for (let i = 0; i < 6; i++) m.presets[0].elements.push({ kind: 'grid', cols: 10, rows: 10, box: 0, dash: 'dashed', colour: 0, width: 1 });
    expect(framingProblem(m)).toMatch(/rectangles/);
  });

  it('encodes and decodes losslessly; damaged bytes are refused', () => {
    const g = sample();
    const bytes = encodeFramingGuides(g);
    expect(decodeFramingGuides(bytes)).toEqual(g);
    expect(decodeFramingGuides(bytes.slice(0, bytes.length - 1))).toBeNull();
    expect(decodeFramingGuides(Uint8Array.from([4, ...bytes.slice(1)]))).toBeNull();
  });

  it('the list: header, boxes of 12 bytes, records of 20 with UI palette numbers from 0xE0', () => {
    const c = compilePreset(sample().presets[0]);
    const list = presetList(c);
    expect(list.length).toBe(4 + 12 * c.boxes.length + 20 * c.records.length);
    expect([list[0], list[1]]).toEqual([1, c.records.length]);
    expect(list[4 + 12 + 16]).toBe(0xe0 + 3);
  });

  it('the camera menu names use only letters each language’s font has', () => {
    if (!files.length) return;
    const d = new fw.Firmware(new Uint8Array(readFileSync(files[0][1]))).decoded;
    names120.LANGS.forEach((lang, k) => {
      const allowed = names120.allowedChars(d, lang);
      for (const text of [FRAMING_GRID_NAMES.custom3[k], FRAMING_GRID_NAMES.custom4[k]]) {
        expect([...text].filter((c) => !allowed.has(c.charCodeAt(0))), `${lang}: ${text}`).toEqual([]);
      }
    });
  });
});

describe.each(files)('Framing guides: builds of %s', (_release, file) => {
  it('builds, records the guides and reads them back; the camera’s own styles are left out', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(file)));
    expect(eng.info.features.framing).toBe(true);
    const g = sample();
    const b = await eng.buildFirmware([], [], [], { framing: g });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect(readExtensionFeatures(rtosOf(b.file))?.framing).toEqual(g);
    const s = await eng.inspect(b.file);
    expect(s.framing).toEqual(g);
    // only one preset of its own, with an added ratio (the palette copy is the shade's)
    const one = defaultFramingGuides();
    one.presets[1] = g.presets[1];
    one.palette = g.palette;
    const b2 = await eng.buildFirmware([], [{ ratio: '65:24', name: '65:24' }], [], { framing: one });
    expect(readExtensionFeatures(rtosOf(b2.file))?.framing).toEqual(one);
    await expect(eng.buildFirmware([], [], [], { framing: defaultFramingGuides() })).rejects.toThrow(/nothing to change/);
    await expect(eng.buildFirmware([], [], [], { framing: g, customGrid: { g3: [true, true, true, true, true, true, false, false], g4: [true, true, true, true, true, true, true, true] } })).rejects.toThrow(/cannot be combined/);
  }, 120_000);
});
