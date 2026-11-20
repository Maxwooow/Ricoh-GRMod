import { describe, expect, it } from 'vitest';

import { cardRole, planRecipeCard } from '../src/card';
import { EXAMPLE_RECIPES, RECIPE_SETTINGS, isRecipeDoneFile, recipeChoice, recipeDoneFile, recipeLines, recipeProblem, recipeScript, recipeScriptName, recipeSettingsFor, validRecipeName } from '../src/usermode';
import type { Recipe, RecipeModel } from '../src/usermode';
import { MODEL_FILE, MODEL_FILE_MAGIC, MODEL_INFO, runScript } from '../src/wallpaper';
import type { SimFs } from '../src/wallpaper';

const NYC = EXAMPLE_RECIPES[0];
const ID = '1A2B';
const DONE = `C:\\${recipeDoneFile(ID)}`;

function camera(product: readonly number[], extra: [string, Uint8Array][] = []): SimFs {
  return { files: new Map<string, Uint8Array>([[MODEL_FILE, Uint8Array.from([...MODEL_FILE_MAGIC, ...product, 0x11, 0x22])], ...extra]) };
}
const sent = (trace: string[]): string[] => trace.filter((x) => x.startsWith('sendln ')).map((x) => x.slice(7));

describe('user mode recipe: values', () => {
  it('sends the camera words and APEX numbers checked on a GR IV 1.21', () => {
    // The lines of the camera test (U1 "NYC Day"), in the order the script sends them.
    expect(recipeLines(NYC, 'STANDARD')).toEqual([
      ['CommonAv', '6'],
      ['StillFocus', 'Snap'],
      ['StillSnapDistanceCm', '200'],
      ['StillFullPressSnap', 'On'],
      ['StillAeMode', 'Highlight'],
      ['StillSvAuto', 'On'],
      ['StillSvAutoUpper', '10'],
      ['StillSvAutoLower', '5'],
      ['StillSvAutoLowerTv', '8'],
      ['StillNdFilter', 'Auto'],
      ['StillStillRecordForm', 'RawPlus'],
      ['StillActiveImageControlSet', 'No0'],
      ['StillImageControlNo0', 'PositiveFilm'],
      ['StillWhiteBalance', 'AutoStandard'],
      ['StillHighlightCorrect', 'Auto'],
      ['CommonXv', '-0.6667'],
    ]);
  });

  it('converts to APEX: Av = 2 log2 N, Sv = log2(ISO / 3.125), Tv = log2(1 / t), EV in thirds', () => {
    expect(recipeChoice('aperture', 'F2.8')!.value).toBe('3');
    expect(recipeChoice('aperture', 'F5.6')!.value).toBe('5');
    expect(recipeChoice('aperture', 'F16')!.value).toBe('8');
    expect(recipeChoice('isoUpper', '6400')!.value).toBe('11');
    expect(recipeChoice('isoUpper', '125')!.value).toBe('5.3333');
    expect(recipeChoice('minShutter', '1/60')!.value).toBe('6');
    expect(recipeChoice('minShutter', '1/1000')!.value).toBe('10');
    expect(recipeChoice('exposureComp', '0.0')!.value).toBe('0');
    expect(recipeChoice('exposureComp', '-0.3')!.value).toBe('-0.3333');
    expect(recipeChoice('exposureComp', '+5.0')!.value).toBe('5');
    expect(recipeChoice('exposureComp', '-5.0')!.value).toBe('-5');
    // each number is close to the exact APEX value of its label
    for (const c of RECIPE_SETTINGS.find((s) => s.id === 'aperture')!.choices) expect(Math.abs(Number(c.value) - 2 * Math.log2(Number(c.label.slice(1))))).toBeLessThan(0.1);
    for (const c of RECIPE_SETTINGS.find((s) => s.id === 'isoUpper')!.choices) expect(Math.abs(Number(c.value) - Math.log2(Number(c.label) / 3.125))).toBeLessThan(0.04);
    for (const c of RECIPE_SETTINGS.find((s) => s.id === 'minShutter')!.choices) expect(Math.abs(Number(c.value) - Math.log2(Number(c.label.slice(2))))).toBeLessThan(0.1);
  });

  it('has unique ASCII ids and shell-safe values', () => {
    for (const s of RECIPE_SETTINGS) {
      const ids = s.choices.map((c) => c.id);
      expect(new Set(ids).size, s.id).toBe(ids.length);
      for (const c of s.choices) {
        expect(c.id).toMatch(/^[\x21-\x7e]+$/);
        expect(c.value).toMatch(/^[A-Za-z0-9_.-]+$/);
      }
    }
  });

  it('leaves colour settings out on the Monochrome', () => {
    const mono = recipeLines(NYC, 'MONO').map(([p]) => p);
    expect(mono).not.toContain('StillImageControlNo0');
    expect(mono).not.toContain('StillActiveImageControlSet');
    expect(mono).not.toContain('StillWhiteBalance');
    expect(mono).toContain('CommonAv');
  });

  it('counts and checks the settings per model: nothing left on the Monochrome, ISO Auto limits the wrong way round', () => {
    const colour = { name: 'c', values: { imageControl: 'Vivid', whiteBalance: 'Daylight' } };
    expect(recipeSettingsFor(colour, 'STANDARD')).toHaveLength(2);
    expect(recipeSettingsFor(colour, 'MONO')).toHaveLength(0);
    expect(recipeProblem(colour, 'STANDARD')).toBeNull();
    expect(recipeProblem(colour, 'MONO')).toBe('empty');
    expect(() => recipeScript(colour, 'MONO', ID)).toThrow();
    const iso = { name: 'i', values: { isoUpper: '800', isoLower: '1600' } };
    expect(recipeProblem(iso, 'HDF')).toBe('iso-limits');
    expect(() => recipeScript(iso, 'HDF', ID)).toThrow();
    expect(recipeProblem({ name: 'i', values: { isoUpper: '800', isoLower: '800' } }, 'HDF')).toBeNull();
  });

  it('refuses unknown choices and names that cannot go into the script', () => {
    expect(() => recipeLines({ name: 'x', values: { aperture: 'F1.4' } }, 'STANDARD')).toThrow();
    expect(validRecipeName('NYC Day')).toBe(true);
    for (const bad of ['', ' lead', 'trail ', "it's", 'a"b', 'é', 'x'.repeat(33), 'two\nlines']) expect(validRecipeName(bad), bad).toBe(false);
    expect(() => recipeScript({ name: 'empty', values: {} }, 'STANDARD', ID)).toThrow();
    expect(() => recipeScript(NYC, 'STANDARD', '12')).toThrow();
  });
});

describe('user mode recipe: script', () => {
  for (const model of ['STANDARD', 'HDF', 'MONO'] as RecipeModel[]) {
    it(`${model}: sets each value once, writes the done file, then does nothing at the next power-on`, () => {
      const fs = camera(MODEL_INFO[model].productBytes);
      const script = recipeScript(NYC, model, ID);
      const first = runScript(script, fs);
      expect(first.error).toBeUndefined();
      expect(first.exited).toBe(true);
      expect(sent(first.trace)).toEqual(recipeLines(NYC, model).map(([p, v]) => `UserData Set ${p} ${v}`));
      expect(String.fromCharCode(...fs.files.get(DONE)!)).toBe('NYC Day');
      const second = runScript(script, fs);
      expect(second.error).toBeUndefined();
      expect(sent(second.trace)).toEqual([]);
    });
  }

  it('runs on every GR IV model whichever model it was written for (one firmware for all)', () => {
    for (const model of ['STANDARD', 'HDF', 'MONO'] as RecipeModel[]) {
      const r = runScript(recipeScript(NYC, 'STANDARD', ID), camera(MODEL_INFO[model].productBytes));
      expect(sent(r.trace).length, model).toBeGreaterThan(0);
    }
  });

  it('does nothing on another camera, with a bad model file or with a firmware update on the card', () => {
    const script = recipeScript(NYC, 'STANDARD', ID);
    const cases: [string, SimFs][] = [
      ['GR IIIx HDF', camera(MODEL_INFO.GR3X_HDF.productBytes)],
      ['one byte off', camera([0xe0, 0x32, 0x01, 0x01])],
      ['bad magic', { files: new Map([[MODEL_FILE, Uint8Array.from([0, 0, 0, 0, 0xe0, 0x32, 0x01, 0x00])]]) }],
      ['short model file', { files: new Map([[MODEL_FILE, Uint8Array.from([0xa5, 0x5a])]]) }],
      ['no model file', { files: new Map() }],
      ['firmware on the card', camera(MODEL_INFO.STANDARD.productBytes, [['C:\\fwdc248b.bin', new Uint8Array(4)]])],
    ];
    for (const [what, fs] of cases) {
      const r = runScript(script, fs);
      expect(r.error, what).toBeUndefined();
      expect(sent(r.trace), what).toEqual([]);
      expect(fs.files.has(DONE), what).toBe(false);
    }
  });

  it('names its recipe in the first line', () => {
    expect(recipeScriptName(recipeScript(EXAMPLE_RECIPES[1], 'HDF', ID))).toBe('Golden');
    expect(recipeScriptName('; power-off image rotation: STANDARD, 1 image, 5 bytes\n')).toBeNull();
    expect(recipeScriptName('; GR Mod user mode recipe: Golden')).toBe('Golden');
  });

  it('is ASCII with LF line endings and a final newline', () => {
    const s = recipeScript(NYC, 'HDF', ID);
    expect(s).toMatch(/^[\x0a\x20-\x7e]*\n$/);
    expect(s).not.toContain('\r');
  });

  it('every example runs', () => {
    for (const r of EXAMPLE_RECIPES) {
      const fs = camera(MODEL_INFO.HDF.productBytes);
      const res = runScript(recipeScript(r as Recipe, 'HDF', ID), fs);
      expect(res.error, r.name).toBeUndefined();
      expect(sent(res.trace).length, r.name).toBe(recipeLines(r, 'HDF').length);
    }
  });
});

describe('user mode recipe: card', () => {
  const entry = [{ name: '00078560.636', data: new Uint8Array([1]) }, { name: 'DEVELOP.MOD', data: new Uint8Array([2]) }];
  const script = recipeScript(NYC, 'STANDARD', ID);

  it('moves the firmware, an earlier script and earlier done files aside; writes missing entry files and the script last', () => {
    const steps = planRecipeCard({
      root: [
        { name: 'fwdc248b.bin', dir: false, size: 1 }, { name: 'DEVELOP.MOD', dir: false, size: 10 }, { name: 'GRUM0001.TXT', dir: false, size: 3 },
        { name: 'DCIM', dir: true, size: 0 }, { name: 'script', dir: true, size: 0 },
      ],
      script: [{ name: 'startup.ttl', dir: false, size: 100 }],
    }, entry, script, isRecipeDoneFile, '20261120-120000');
    expect(steps.map((s) => (s.op === 'move' ? `move ${s.from.join('/')} -> ${s.to.join('/')}` : `write ${s.path.join('/')}`))).toEqual([
      'move fwdc248b.bin -> GRMOD/parked-20261120-120000/fwdc248b.bin',
      'move GRUM0001.TXT -> GRMOD/parked-20261120-120000/GRUM0001.TXT',
      'move script/startup.ttl -> GRMOD/parked-20261120-120000/script/startup.ttl',
      'write 00078560.636',
      'write script/startup.ttl',
    ]);
    const last = steps[steps.length - 1];
    expect(last.op === 'write' && String.fromCharCode(...last.data)).toBe(script);
  });

  it('on an empty card writes the entry files and the script', () => {
    const steps = planRecipeCard({ root: [], script: [] }, entry, script, isRecipeDoneFile, 's');
    expect(steps.map((s) => s.op === 'write' && s.path.join('/'))).toEqual(['00078560.636', 'DEVELOP.MOD', 'script/startup.ttl']);
  });

  it('moves the other camera family\'s factory-menu entry file aside', () => {
    const steps = planRecipeCard({ root: [{ name: '00078490.609', dir: false, size: 20 }], script: [] }, entry, script, isRecipeDoneFile, 's');
    expect(steps[0]).toEqual({ op: 'move', from: ['00078490.609'], to: ['GRMOD', 'parked-s', '00078490.609'] });
  });

  it('tells a recipe card from a power-off image card by the script\'s first line', () => {
    const l = { root: [{ name: 'script', dir: true, size: 0 }], script: [{ name: 'startup.ttl', dir: false, size: 100 }] };
    expect(cardRole({ ...l, scriptHead: script.split('\n')[0] })).toBe('recipe');
    expect(cardRole({ ...l, scriptHead: '; power-off image rotation: STANDARD, 2 images, 5 bytes' })).toBe('wallpaper');
    expect(cardRole(l)).toBe('wallpaper');
  });

  it('refuses a script that is not ASCII', () => {
    expect(() => planRecipeCard({ root: [], script: [] }, entry, 'é\n', isRecipeDoneFile, 's')).toThrow();
  });
});
