import { afterAll, describe, expect, it } from 'vitest';

import { CARD_FILES, MODEL_FILE, MODEL_INFO, imageFileName, rotationScript, runScript } from '../src/wallpaper';
import type { CameraModel, SimFs } from '../src/wallpaper';

const SIZE = 56842;
const MODELS: CameraModel[] = ['STANDARD', 'HDF', 'MONO'];
const MAGIC = [0xa5, 0x5a, 0x5a, 0xa5];
const IDX = 'C:\\GBRIDX.TXT';
const STOP = 'C:\\GBRSTOP.TXT';
const FIRMWARE = 'C:\\fwdc248b.bin';
const FACTORY = 0xee; // fill byte of the camera's original image

const text = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const str = (b: Uint8Array | undefined): string | undefined => (b === undefined ? undefined : String.fromCharCode(...b));

/** A camera of `model` with a card holding `count` prepared images; image i is filled with byte i. */
function makeFs(model: CameraModel, count: number, size = SIZE): SimFs {
  const files = new Map<string, Uint8Array>();
  files.set(MODEL_FILE, Uint8Array.from([...MAGIC, ...MODEL_INFO[model].productBytes, 0x11, 0x22, 0x33, 0x44]));
  files.set(MODEL_INFO[model].target, new Uint8Array(size).fill(FACTORY));
  for (let i = 1; i <= count; i++) files.set(`C:\\${imageFileName(i)}`, new Uint8Array(size).fill(i));
  return { files };
}

/** Which image is installed (its fill byte), or FACTORY. */
const installed = (fs: SimFs, model: CameraModel): number => (fs.files.get(MODEL_INFO[model].target) as Uint8Array)[0];
const index = (fs: SimFs): string | undefined => str(fs.files.get(IDX));

function snapshot(fs: SimFs): Map<string, Uint8Array> {
  return new Map([...fs.files].map(([k, v]) => [k, v.slice()]));
}
function expectUnchanged(fs: SimFs, before: Map<string, Uint8Array>): void {
  expect([...fs.files.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [k, v] of before) expect(Buffer.from(fs.files.get(k) as Uint8Array).equals(Buffer.from(v)), `file ${k} changed`).toBe(true);
}
const writes = (trace: string[]): string[] => trace.filter((t) => /^(filecopy|filecreate|filewrite)\b/.test(t));

/** One power-on: the script must run cleanly and end through `exit`. */
function boot(script: string, fs: SimFs): { trace: string[]; steps: number } {
  const r = runScript(script, fs);
  expect(r.error).toBeUndefined();
  expect(r.exited).toBe(true);
  return r;
}
/** A power-on that must not write anything. */
function bootExpectingNothing(script: string, fs: SimFs): void {
  const before = snapshot(fs);
  const r = boot(script, fs);
  expect(writes(r.trace)).toEqual([]);
  expectUnchanged(fs, before);
}

const report: string[] = [];
afterAll(() => console.log(['', 'generated script sizes:', ...report].join('\n')));

// =============================================================================
describe('rotation script: normal operation', () => {
  it('cycles 1, 2, ..., N, 1, ... for every model and N = 1..9', () => {
    for (const model of MODELS) {
      for (let n = 1; n <= 9; n++) {
        const script = rotationScript({ model, size: SIZE, count: n });
        const fs = makeFs(model, n);
        expect(installed(fs, model)).toBe(FACTORY);
        for (let b = 0; b < 2 * n + 3; b++) {
          const r = boot(script, fs);
          const want = (b % n) + 1;
          expect(installed(fs, model), `${model} N=${n} power-on ${b + 1}`).toBe(want);
          expect(index(fs)).toBe(String(((b + 1) % n) + 1));
          const target = fs.files.get(MODEL_INFO[model].target) as Uint8Array;
          expect(target.length).toBe(SIZE);
          expect(target.every((v) => v === want)).toBe(true);
          expect(writes(r.trace)).toEqual([
            `filecopy C:\\${imageFileName(want)} ${MODEL_INFO[model].target} -> ok`,
            expect.stringMatching(/^filecreate C:\\GBRIDX\.TXT -> \d+$/),
            `filewrite ${IDX} '${((b + 1) % n) + 1}'`,
          ]);
        }
        // only the target and the index file were ever written
        expect([...fs.files.keys()].sort()).toEqual(
          [MODEL_FILE, MODEL_INFO[model].target, IDX, ...Array.from({ length: n }, (_v, i) => `C:\\${imageFileName(i + 1)}`)].sort(),
        );
      }
    }
  });

  it('does not depend on what str2code does with the 0x00 identification byte', () => {
    // The 8th byte of BlkCtl15.bin is 0x00, which a string variable cannot hold: it reads as an
    // empty string. Whether str2code then stores 0 or leaves its variable alone, the script must work.
    for (const emptyStr2code of ['zero', 'unchanged'] as const) {
      for (const model of MODELS) {
        const script = rotationScript({ model, size: SIZE, count: 3 });
        const fs = makeFs(model, 3);
        for (let b = 0; b < 7; b++) {
          const r = runScript(script, fs, { emptyStr2code });
          expect(r.error).toBeUndefined();
          expect(r.exited).toBe(true);
          expect(installed(fs, model)).toBe((b % 3) + 1);
        }
        // and the safety exits still hold: wrong last byte, truncated file, zero-byte index
        for (const bytes of [[...MAGIC, ...MODEL_INFO[model].productBytes.slice(0, 3), 0x01], [...MAGIC, ...MODEL_INFO[model].productBytes.slice(0, 3)]]) {
          const other = makeFs(model, 3);
          other.files.set(MODEL_FILE, Uint8Array.from(bytes));
          const before = snapshot(other);
          const r = runScript(script, other, { emptyStr2code });
          expect(r.error).toBeUndefined();
          expect(writes(r.trace)).toEqual([]);
          expectUnchanged(other, before);
        }
        const zeroIndex = makeFs(model, 3);
        zeroIndex.files.set(IDX, Uint8Array.from([0x00]));
        expect(runScript(script, zeroIndex, { emptyStr2code }).error).toBeUndefined();
        expect(installed(zeroIndex, model)).toBe(1);
        expect(index(zeroIndex)).toBe('2');
      }
    }
  });

  it('works with another image size and only touches the files of its own model', () => {
    const script = rotationScript({ model: 'MONO', size: 7264, count: 3 });
    const fs = makeFs('MONO', 3, 7264);
    fs.files.set(MODEL_INFO.STANDARD.target, new Uint8Array(7264).fill(0x55));
    fs.files.set(MODEL_INFO.HDF.target, new Uint8Array(7264).fill(0x56));
    for (let b = 0; b < 5; b++) {
      boot(script, fs);
      expect(installed(fs, 'MONO')).toBe((b % 3) + 1);
    }
    expect(installed(fs, 'STANDARD')).toBe(0x55);
    expect(installed(fs, 'HDF')).toBe(0x56);
  });

  it('paths are matched case-insensitively, as on the FAT card', () => {
    const script = rotationScript({ model: 'HDF', size: SIZE, count: 2 });
    const fs = makeFs('HDF', 0);
    fs.files.set('c:\\gbr1.jpg', new Uint8Array(SIZE).fill(1));
    fs.files.set('C:\\Gbr2.Jpg', new Uint8Array(SIZE).fill(2));
    fs.files.set('C:\\gbridx.txt', text('2'));
    boot(script, fs);
    expect(installed(fs, 'HDF')).toBe(2);
    expect(str(fs.files.get('C:\\gbridx.txt'))).toBe('1'); // the existing file was rewritten, no second one created
    expect(fs.files.has(IDX)).toBe(false);
  });
});

// =============================================================================
describe('rotation script: safety exits', () => {
  const model: CameraModel = 'HDF';
  const script = rotationScript({ model, size: SIZE, count: 4 });

  it('pause file present: nothing is written, and rotation resumes when it is removed', () => {
    const fs = makeFs(model, 4);
    boot(script, fs); // installs 1
    boot(script, fs); // installs 2
    fs.files.set(STOP, new Uint8Array(0));
    for (let i = 0; i < 3; i++) bootExpectingNothing(script, fs);
    expect(installed(fs, model)).toBe(2);
    expect(index(fs)).toBe('3');
    fs.files.delete(STOP);
    boot(script, fs);
    expect(installed(fs, model)).toBe(3);
    // any spelling of the name counts, with any content
    fs.files.set('C:\\gbrstop.txt', text('paused by user'));
    bootExpectingNothing(script, fs);
  });

  it('firmware update file present: nothing is written', () => {
    for (const name of [FIRMWARE, 'C:\\FWDC248B.BIN']) {
      const fs = makeFs(model, 4);
      fs.files.set(name, new Uint8Array(1000));
      bootExpectingNothing(script, fs);
      expect(installed(fs, model)).toBe(FACTORY);
      expect(index(fs)).toBeUndefined();
      fs.files.set(IDX, text('3'));
      bootExpectingNothing(script, fs);
    }
  });

  it('the pause and firmware checks come before anything else is read', () => {
    const fs = makeFs(model, 4);
    fs.files.set(STOP, new Uint8Array(0));
    expect(runScript(script, fs).trace).toEqual(['filesearch C:\\GBRSTOP.TXT -> 1']);
    fs.files.delete(STOP);
    fs.files.set(FIRMWARE, new Uint8Array(8));
    expect(runScript(script, fs).trace).toEqual(['filesearch C:\\GBRSTOP.TXT -> 0', 'filesearch C:\\fwdc248b.bin -> 1']);
  });

  it('another camera model: nothing is written', () => {
    for (const scriptModel of MODELS) {
      const s = rotationScript({ model: scriptModel, size: SIZE, count: 4 });
      for (const camera of MODELS) {
        const fs = makeFs(camera, 4);
        // give this camera the target files of every model so that only the model check can stop the script
        for (const m of MODELS) fs.files.set(MODEL_INFO[m].target, new Uint8Array(SIZE).fill(FACTORY));
        if (camera === scriptModel) {
          boot(s, fs);
          expect(installed(fs, scriptModel)).toBe(1);
        } else {
          bootExpectingNothing(s, fs);
        }
      }
    }
  });

  it('any single wrong byte among the first 8 of BlkCtl15.bin: nothing is written', () => {
    for (const m of MODELS) {
      const s = rotationScript({ model: m, size: SIZE, count: 4 });
      const good = [...MAGIC, ...MODEL_INFO[m].productBytes];
      for (let i = 0; i < 8; i++) {
        for (const wrong of [good[i] ^ 0x01, good[i] ^ 0x80, 0x00, 0xff, 0x41].filter((v) => v !== good[i])) {
          const fs = makeFs(m, 4);
          const bytes = [...good, 1, 2, 3];
          bytes[i] = wrong;
          fs.files.set(MODEL_FILE, Uint8Array.from(bytes));
          bootExpectingNothing(s, fs);
        }
      }
      // bytes after the first 8 do not matter
      const fs = makeFs(m, 4);
      fs.files.set(MODEL_FILE, Uint8Array.from(good));
      boot(s, fs);
      expect(installed(fs, m)).toBe(1);
    }
  });

  it('wrong magic, short or missing BlkCtl15.bin: nothing is written', () => {
    for (const m of MODELS) {
      const s = rotationScript({ model: m, size: SIZE, count: 4 });
      const good = [...MAGIC, ...MODEL_INFO[m].productBytes];
      const variants: (number[] | null)[] = [
        null, // file missing
        [0x5a, 0xa5, 0xa5, 0x5a, ...MODEL_INFO[m].productBytes], // magic reversed
        [0, 0, 0, 0, ...MODEL_INFO[m].productBytes],
        [...MODEL_INFO[m].productBytes, ...MAGIC],
      ];
      // every length from 0 to 7, including "all but the final 0x00 byte"
      for (let len = 0; len < 8; len++) variants.push(good.slice(0, len));
      for (const v of variants) {
        const fs = makeFs(m, 4);
        if (v === null) fs.files.delete(MODEL_FILE);
        else fs.files.set(MODEL_FILE, Uint8Array.from(v));
        bootExpectingNothing(s, fs);
        expect(installed(fs, m)).toBe(FACTORY);
      }
    }
  });

  it('internal file of another size: nothing is written, the index is left alone', () => {
    for (const size of [SIZE - 1, SIZE + 1, 0, 7264, 56571]) {
      for (const idx of [undefined, '3']) {
        const fs = makeFs(model, 4);
        fs.files.set(MODEL_INFO[model].target, new Uint8Array(size).fill(FACTORY));
        if (idx) fs.files.set(IDX, text(idx));
        bootExpectingNothing(script, fs);
        expect(index(fs)).toBe(idx);
      }
    }
    // internal file missing altogether
    const fs = makeFs(model, 4);
    fs.files.delete(MODEL_INFO[model].target);
    bootExpectingNothing(script, fs);
    expect(fs.files.has(MODEL_INFO[model].target)).toBe(false);
  });
});

// =============================================================================
describe('rotation script: imperfect cards', () => {
  const model: CameraModel = 'STANDARD';
  const script = rotationScript({ model, size: SIZE, count: 4 });

  it('a missing image is skipped: no copy, the index still advances, the next power-on continues', () => {
    const fs = makeFs(model, 4);
    fs.files.delete('C:\\GBR2.JPG');
    boot(script, fs);
    expect(installed(fs, model)).toBe(1);
    const r = boot(script, fs); // image 2 is missing
    expect(r.trace.some((t) => t.startsWith('filecopy'))).toBe(false);
    expect(installed(fs, model)).toBe(1);
    expect(index(fs)).toBe('3');
    boot(script, fs);
    expect(installed(fs, model)).toBe(3);
    boot(script, fs);
    expect(installed(fs, model)).toBe(4);
    expect(index(fs)).toBe('1');
  });

  it('an image of the wrong size is skipped the same way', () => {
    for (const size of [SIZE - 1, SIZE + 1, 0, 56571]) {
      const fs = makeFs(model, 4);
      fs.files.set('C:\\GBR1.JPG', new Uint8Array(size).fill(1));
      fs.files.set('C:\\GBR3.JPG', new Uint8Array(size).fill(3));
      const seen: number[] = [];
      for (let b = 0; b < 8; b++) {
        boot(script, fs);
        seen.push(installed(fs, model));
        expect((fs.files.get(MODEL_INFO[model].target) as Uint8Array).length).toBe(SIZE);
      }
      expect(seen).toEqual([FACTORY, 2, 2, 4, 4, 2, 2, 4]);
      expect(index(fs)).toBe('1');
    }
  });

  it('no usable image at all: the internal file is never touched', () => {
    const fs = makeFs(model, 0);
    for (let b = 0; b < 5; b++) {
      const r = boot(script, fs);
      expect(r.trace.some((t) => t.startsWith('filecopy'))).toBe(false);
      expect(installed(fs, model)).toBe(FACTORY);
      expect(index(fs)).toBe(String(((b + 1) % 4) + 1));
    }
  });

  it('an unusable index file counts as 1', () => {
    const bad: Uint8Array[] = [
      new Uint8Array(0), // empty
      text('12'), // 2 bytes
      text('2\n'),
      text('0'),
      text('5'), // > N
      text('9'),
      text('A'),
      text('a'),
      text(' '),
      Uint8Array.from([0x00]),
      Uint8Array.from([0xff]),
      Uint8Array.from([0x32, 0x00, 0x00]),
    ];
    for (const content of bad) {
      const fs = makeFs(model, 4);
      fs.files.set(IDX, content);
      boot(script, fs);
      expect(installed(fs, model), `index ${JSON.stringify(Array.from(content))}`).toBe(1);
      expect(index(fs)).toBe('2');
    }
    // the valid digits, for contrast
    for (let d = 1; d <= 4; d++) {
      const fs = makeFs(model, 4);
      fs.files.set(IDX, text(String(d)));
      boot(script, fs);
      expect(installed(fs, model)).toBe(d);
      expect(index(fs)).toBe(String((d % 4) + 1));
    }
    // N = 1: the index is always rewritten as 1
    const one = rotationScript({ model, size: SIZE, count: 1 });
    for (const content of [text('7'), text('1'), new Uint8Array(0)]) {
      const fs = makeFs(model, 1);
      fs.files.set(IDX, content);
      boot(one, fs);
      expect(installed(fs, model)).toBe(1);
      expect(index(fs)).toBe('1');
    }
    // N = 9 uses all digits
    const nine = rotationScript({ model, size: SIZE, count: 9 });
    const fs9 = makeFs(model, 9);
    fs9.files.set(IDX, text('9'));
    boot(nine, fs9);
    expect(installed(fs9, model)).toBe(9);
    expect(index(fs9)).toBe('1');
  });

  it('a failed copy leaves the index advancing and the next power-on works', () => {
    const fs = makeFs(model, 4);
    let failures = 1;
    fs.failCopy = (src, dst) => {
      expect(src).toBe('C:\\GBR1.JPG');
      expect(dst).toBe(MODEL_INFO[model].target);
      return failures-- > 0;
    };
    const r = boot(script, fs);
    expect(r.trace).toContain(`filecopy C:\\GBR1.JPG ${MODEL_INFO[model].target} -> failed`);
    expect(installed(fs, model)).toBe(FACTORY);
    expect(index(fs)).toBe('2');
    fs.failCopy = undefined;
    boot(script, fs);
    expect(installed(fs, model)).toBe(2);
    expect(index(fs)).toBe('3');
    // copies that always fail never stop the index from cycling
    const stuck = makeFs(model, 4);
    stuck.failCopy = () => true;
    for (let b = 0; b < 6; b++) {
      boot(script, stuck);
      expect(installed(stuck, model)).toBe(FACTORY);
      expect(index(stuck)).toBe(String(((b + 1) % 4) + 1));
    }
  });

  it('if the index file cannot be written the script still ends cleanly', () => {
    const fs = makeFs(model, 4);
    fs.files.set(IDX, text('2'));
    fs.failCreate = (path) => path === IDX;
    for (let b = 0; b < 3; b++) {
      const r = boot(script, fs);
      expect(r.trace.some((t) => t.startsWith('filewrite'))).toBe(false);
      expect(installed(fs, model)).toBe(2); // same image again: the index could not advance
      expect(index(fs)).toBe('2');
    }
  });
});

// =============================================================================
describe('rotation script: generated text', () => {
  const ALLOWED_COMMANDS = ['filesearch', 'filestat', 'fileopen', 'fileread', 'str2code', 'fileclose', 'filecreate', 'filewrite', 'filecopy', 'strcompare', 'if', 'endif', 'goto', 'exit'];

  it('is ASCII, LF-only, short-lined and uses only the allowed commands', () => {
    for (const model of MODELS) {
      for (let n = 1; n <= 9; n++) {
        const s = rotationScript({ model, size: SIZE, count: n });
        expect(/^[\x20-\x7e\n]*$/.test(s), 'ASCII only, no CR, no tabs').toBe(true);
        expect(s.endsWith('\n')).toBe(true);
        expect(s.includes('\n\n')).toBe(false);
        let depth = 0;
        const variables = new Set<string>();
        for (const line of s.slice(0, -1).split('\n')) {
          expect(line.length).toBeLessThanOrEqual(120);
          expect(line).toBe(line.trimEnd());
          const body = line.trimStart();
          if (body.startsWith(';')) continue;
          if (body.startsWith(':')) {
            expect(body).toMatch(/^:[a-z]+$/);
            continue;
          }
          const first = body.split(' ')[0];
          const assignment = /^([a-z]+) = (-?\d+|'[^']*')$/.exec(body);
          if (assignment) variables.add(assignment[1]);
          else expect(ALLOWED_COMMANDS, `line "${line}"`).toContain(first);
          // 4-space indentation per nesting level
          if (first === 'endif') depth--;
          expect(line.length - body.length).toBe(depth * 4);
          if (first === 'if') {
            expect(body).toMatch(/^if [a-z]+ (=|<>|<|>) -?\d+ then$/);
            depth++;
          }
        }
        expect(depth).toBe(0);
        expect(/\bnext\b/i.test(s)).toBe(false); // not even in a comment
        const code = s.split('\n').filter((l) => !l.startsWith(';')).join('\n');
        expect(/\b(else|elseif|for|while|call|include|pause|mpause|messagebox)\b/i.test(code)).toBe(false);
        for (const v of variables) {
          expect(v.length).toBeLessThanOrEqual(6);
          expect(ALLOWED_COMMANDS).not.toContain(v);
        }
        expect([...variables].sort()).toEqual(['code', 'idx', 'nxt', 'ok', 'src', 'sz', 'target']);
      }
    }
  });

  it('checks exactly the 8 identification bytes of the chosen model, in order, and names only its own target', () => {
    for (const model of MODELS) {
      const s = rotationScript({ model, size: SIZE, count: 4 });
      const codes = [...s.matchAll(/^if code <> (\d+) then$/gm)].map((m) => Number(m[1]));
      expect(codes).toEqual([...MAGIC, ...MODEL_INFO[model].productBytes]);
      expect(s).toContain(`target = '${MODEL_INFO[model].target}'`);
      for (const other of MODELS) if (other !== model) expect(s).not.toContain(MODEL_INFO[other].resourceName);
      expect(s.match(/E:\\BlkCtl15\.bin/g)?.length).toBe(2);
      expect(s).toContain(`if sz <> ${SIZE} then`);
    }
  });

  it('stays small', () => {
    for (const n of [1, 4, 9]) {
      const s = rotationScript({ model: 'HDF', size: SIZE, count: n });
      report.push(`HDF, N=${n}: ${s.length} bytes, ${s.split('\n').length - 1} lines`);
      expect(s.length).toBeLessThan(3000);
    }
    const worst = Math.max(...MODELS.map((m) => rotationScript({ model: m, size: 99999999, count: 9 }).length));
    expect(worst).toBeLessThan(3000);
    // and runs in a bounded number of steps
    const fs = makeFs('HDF', 9);
    fs.files.set(IDX, text('9'));
    expect(runScript(rotationScript({ model: 'HDF', size: SIZE, count: 9 }), fs).steps).toBeLessThan(120);
  });

  it('validates its arguments and exposes the model facts', () => {
    expect(() => rotationScript({ model: 'HDF', size: SIZE, count: 0 })).toThrow(RangeError);
    expect(() => rotationScript({ model: 'HDF', size: SIZE, count: 10 })).toThrow(RangeError);
    expect(() => rotationScript({ model: 'HDF', size: SIZE, count: 2.5 })).toThrow(RangeError);
    expect(() => rotationScript({ model: 'HDF', size: 0, count: 4 })).toThrow(RangeError);
    expect(() => rotationScript({ model: 'HDF', size: 1.5, count: 4 })).toThrow(RangeError);
    expect(() => rotationScript({ model: 'GR5' as CameraModel, size: SIZE, count: 4 })).toThrow(RangeError);
    expect(imageFileName(1)).toBe('GBR1.JPG');
    expect(imageFileName(9)).toBe('GBR9.JPG');
    expect(() => imageFileName(0)).toThrow(RangeError);
    expect(() => imageFileName(10)).toThrow(RangeError);
    expect(MODEL_INFO).toEqual({
      STANDARD: { productBytes: [0xe0, 0x32, 0x01, 0x00], target: 'A:\\Resource\\Jpeg\\GoodBye.jpg', resourceName: 'GoodBye.jpg' },
      HDF: { productBytes: [0xe1, 0x32, 0x01, 0x00], target: 'A:\\Resource\\Jpeg\\GB_HDF.jpg', resourceName: 'GB_HDF.jpg' },
      MONO: { productBytes: [0x30, 0x33, 0x01, 0x00], target: 'A:\\Resource\\Jpeg\\GB_Mono.jpg', resourceName: 'GB_Mono.jpg' },
    });
    expect(CARD_FILES).toEqual({ index: 'GBRIDX.TXT', stop: 'GBRSTOP.TXT', firmware: 'fwdc248b.bin', script: 'script\\startup.ttl' });
    expect(MODEL_FILE).toBe('E:\\BlkCtl15.bin');
  });
});

// =============================================================================
describe('rotation script: equivalent to the hand-written 4-image script', () => {
  // Tail of the script that is known to work on the camera (after `target` has been set).
  const KNOWN_GOOD_TAIL = `idx = 49
sz = -1
filestat 'C:\\GBRIDX.TXT' sz
if sz <> 1 then
    goto pick
endif
fileopen fh 'C:\\GBRIDX.TXT' 0
if fh < 0 then
    goto pick
endif
fileread fh 1 chunk
str2code idx chunk
fileclose fh
:pick
src = 'C:\\GBR1.JPG'
nxt = '2'
if idx = 50 then
    src = 'C:\\GBR2.JPG'
    nxt = '3'
endif
if idx = 51 then
    src = 'C:\\GBR3.JPG'
    nxt = '4'
endif
if idx = 52 then
    src = 'C:\\GBR4.JPG'
    nxt = '1'
endif
sz = -1
filestat target sz
if sz <> 56842 then
    exit
endif
ok = 1
sz = -1
filestat src sz
if sz <> 56842 then
    ok = 0
endif
if ok = 1 then
    filecopy src target
endif
filecreate fh 'C:\\GBRIDX.TXT'
if fh < 0 then
    exit
endif
filewrite fh nxt
fileclose fh
exit
`;

  it('the generated N=4 script ends with exactly that tail', () => {
    for (const model of MODELS) {
      const generated = rotationScript({ model, size: 56842, count: 4 });
      const withoutComments = generated
        .split('\n')
        .filter((l) => !l.startsWith(';'))
        .join('\n');
      expect(withoutComments.endsWith(`target = '${MODEL_INFO[model].target}'\n${KNOWN_GOOD_TAIL}`)).toBe(true);
    }
  });

  it('both scripts leave the same files behind in every scenario', () => {
    const model: CameraModel = 'HDF';
    const generated = rotationScript({ model, size: 56842, count: 4 });
    const handWritten = `target = '${MODEL_INFO[model].target}'\n${KNOWN_GOOD_TAIL}`;
    const scenarios: ((fs: SimFs) => void)[] = [
      () => {},
      (fs) => fs.files.set(IDX, text('3')),
      (fs) => fs.files.set(IDX, text('4')),
      (fs) => fs.files.set(IDX, text('x')),
      (fs) => fs.files.set(IDX, text('44')),
      (fs) => fs.files.set(IDX, new Uint8Array(0)),
      (fs) => fs.files.delete('C:\\GBR2.JPG'),
      (fs) => fs.files.set('C:\\GBR3.JPG', new Uint8Array(100)),
      (fs) => fs.files.set(MODEL_INFO[model].target, new Uint8Array(56571)),
      (fs) => {
        let n = 0;
        fs.failCopy = () => n++ === 1;
      },
      (fs) => {
        fs.failCreate = () => true;
      },
    ];
    for (const prepare of scenarios) {
      const a = makeFs(model, 4);
      const b = makeFs(model, 4);
      prepare(a);
      prepare(b);
      for (let i = 0; i < 10; i++) {
        const ra = runScript(generated, a);
        const rb = runScript(handWritten, b);
        expect(ra.error).toBeUndefined();
        expect(rb.error).toBeUndefined();
        expect(ra.exited && rb.exited).toBe(true);
        expectUnchanged(a, b.files);
        // same write operations in the same order (file handle numbers aside)
        const ops = (trace: string[]): string[] => writes(trace).map((t) => t.replace(/-> \d+$/, '-> handle'));
        expect(ops(ra.trace)).toEqual(ops(rb.trace));
      }
    }
  });
});

// =============================================================================
describe('script simulator', () => {
  const run = (script: string, files: [string, Uint8Array][] = [], maxSteps?: number) => {
    const fs: SimFs = { files: new Map(files) };
    return { ...runScript(script, fs, maxSteps === undefined ? undefined : { maxSteps }), fs };
  };
  const write = (expr: string): string => `filecreate fh 'C:\\OUT.TXT'\nfilewrite fh ${expr}\nfileclose fh\n`;
  const out = (r: { fs: SimFs }): string | undefined => str(r.fs.files.get('C:\\OUT.TXT'));

  it('reports anything outside the supported subset as an error', () => {
    const rejected: [string, RegExp][] = [
      ["messagebox 'hi' 'title'\n", /unknown command "messagebox"/],
      ['pause 1\n', /unknown command "pause"/],
      ["filedelete 'C:\\X'\n", /unknown command "filedelete"/],
      ["sprintf2 s '%d' 1\n", /unknown command/],
      ['x = 1\nif x = 1 then\nelse\nendif\n', /unknown command "else"/],
      ['x = 1\nif x = 1 then\nelseif x = 2 then\nendif\n', /unknown command "elseif"/],
      ['for i 1 3\nnext\n', /unknown command "for"/],
      ['while 1\nendwhile\n', /unknown command "while"/],
      ['x = 1\nif x = 1 exit\n', /only "if A op B then"/],
      ['x = 1\nif x <= 1 then\nendif\n', /unsupported operator/],
      ['x = 1\nif x >= 1 then\nendif\n', /unsupported operator/],
      ['x = 1\nif x == 1 then\nendif\n', /unsupported operator/],
      ['x = 1\nif x = 1 && x = 1 then\nendif\n', /unexpected character/],
      ['x = 1\nif x then\nendif\n', /only "if A op B then"/],
      ['x = 1\ny = x\n', /only "name = integer"/],
      ['x = 1 + 2\n', /unexpected character|only "name = integer"/],
      ['x = "text"\n', /unexpected character/],
      ['next = 1\n', /"next" is a reserved word/],
      ["filestat 'C:\\X' next\n", /"next" is a reserved word/],
      ['exit = 1\n', /reserved word/],
      ['x = 1 ; trailing comment\n', /comment must be on a line of its own/],
      ['x = 1\r\nexit\r\n', /CR characters/],
      ['x = 1\nif x = 1 then\n', /if without endif/],
      ['endif\n', /endif without if/],
      ['goto nowhere\n', /unknown label "nowhere"/],
      [':a\n:a\n', /duplicate label/],
      ["x = 'unterminated\n", /unterminated string/],
      ["filesearch 'C:\\X' 'C:\\Y'\n", /filesearch takes 1 argument/],
      ['exit now\n', /unexpected text after exit/],
      ["x = 'caf\u00e9'\n", /non-ASCII/],
      ['123\n', /expected a command/],
    ];
    for (const [script, pattern] of rejected) {
      const r = run(script);
      expect(r.error, script).toMatch(pattern);
      expect(r.exited).toBe(false);
      expect(r.steps).toBe(0); // rejected before anything runs, even if the bad line would not be reached
    }
    // an unsupported line after `exit` is still caught
    expect(run("exit\nmessagebox 'x' 'y'\n").error).toMatch(/unknown command/);
  });

  it('reports misuse at run time', () => {
    expect(run('if x = 1 then\nendif\n').error).toMatch(/"x" is used before it is set/);
    expect(run("s = 'a'\nif s = 1 then\nendif\n").error).toMatch(/an integer is required/);
    expect(run('n = 5\nfilesearch n\n').error).toMatch(/a string is required/);
    expect(run("fileopen fh 'C:\\A' 1\n", [['C:\\A', text('x')]]).error).toMatch(/only "fileopen fh path 0"/);
    expect(run("fileopen fh 'C:\\MISSING' 0\nfileread fh 1 s\n").error).toMatch(/file handle is not open/);
    expect(run('fh = 3\nfileclose fh\n').error).toMatch(/file handle is not open/);
    expect(run("fileopen fh 'C:\\A' 0\nfilewrite fh 'x'\n", [['C:\\A', text('x')]]).error).toMatch(/not open for writing/);
    expect(run("filecreate fh 'C:\\A'\nfileread fh 1 s\n").error).toMatch(/not open for reading/);
    expect(run("fileopen fh 'C:\\A' 0\nfileclose fh\nfileread fh 1 s\n", [['C:\\A', text('x')]]).error).toMatch(/file handle is not open/);
    expect(run("fileopen fh 'C:\\A' 0\nexit\n", [['C:\\A', text('x')]]).error).toMatch(/file handle left open/);
    expect(run("filecreate fh 'C:\\A'\n").error).toMatch(/file handle left open/);
  });

  it('stops endless loops', () => {
    const r = run(':again\ngoto again\n');
    expect(r.error).toMatch(/step limit of 10000 exceeded/);
    expect(r.steps).toBe(10001);
    expect(r.exited).toBe(false);
    expect(run(':again\ngoto again\n', [], 50).error).toMatch(/step limit of 50 exceeded/);
    // a loop that ends is fine
    const counted = run(`n = 0\n:top\nfilestat 'C:\\F' n\nif n < 3 then\n    filecreate fh 'C:\\F'\n    filewrite fh 'abc'\n    fileclose fh\n    goto top\nendif\nexit\n`);
    expect(counted.error).toBeUndefined();
    expect(counted.exited).toBe(true);
    expect(str(counted.fs.files.get('C:\\F'))).toBe('abc');
  });

  it('distinguishes exit from running off the end', () => {
    expect(run('x = 1\n')).toMatchObject({ exited: false, steps: 1 });
    expect(run('x = 1\n').error).toBeUndefined();
    expect(run('x = 1\nexit\nx = 2\n')).toMatchObject({ exited: true, steps: 2 });
    expect(run('')).toMatchObject({ exited: false, steps: 0 });
    expect(run('; only a comment\n\n   \n').error).toBeUndefined();
  });

  it('file commands behave as on the camera', () => {
    const files: [string, Uint8Array][] = [
      ['C:\\DATA.BIN', Uint8Array.from([0x41, 0x00, 0xe1, 0x42])],
      ['A:\\Dir\\Mixed.Case', text('hello')],
    ];
    // filesearch: 1 / 0, case-insensitive
    expect(out(run(`filesearch 'c:\\data.bin'\nr = 'no'\nif result = 1 then\n    r = 'yes'\nendif\n${write('r')}`, files))).toBe('yes');
    expect(out(run(`filesearch 'C:\\NOPE'\nr = 'no'\nif result = 0 then\n    r = 'zero'\nendif\n${write('r')}`, files))).toBe('zero');
    // filestat: size, or the variable is left unchanged
    const stat = (path: string) => run(`sz = -1\nfilestat '${path}' sz\nr = 'other'\nif sz = -1 then\n    r = 'unchanged'\nendif\nif sz = 5 then\n    r = 'five'\nendif\n${write('r')}`, files);
    expect(out(stat('a:\\dir\\mixed.case'))).toBe('five');
    expect(out(stat('A:\\Dir\\Missing'))).toBe('unchanged');
    // fileopen failure gives a negative handle
    expect(out(run(`fileopen fh 'C:\\NOPE' 0\nr = 'opened'\nif fh < 0 then\n    r = 'failed'\nendif\n${write('r')}`, files))).toBe('failed');
    // fileread + str2code byte by byte: 0x41, 0x00 (reads as an empty string -> 0), 0xE1, 0x42, then end of file -> 0
    const codes = run(
      `fileopen fh 'C:\\DATA.BIN' 0\nfilecreate o 'C:\\OUT.TXT'\n` +
        [0x41, 0x00, 0xe1, 0x42, 0x00]
          .map((want) => `fileread fh 1 chunk\nstr2code code chunk\nif code = ${want} then\n    filewrite o 'y'\nendif\nif code <> ${want} then\n    filewrite o 'n'\nendif\n`)
          .join('') +
        'fileclose fh\nfileclose o\n',
      files,
    );
    expect(codes.error).toBeUndefined();
    expect(out(codes)).toBe('yyyyy');
    // fileread of several bytes; a zero byte ends the string
    expect(out(run(`fileopen fh 'A:\\Dir\\Mixed.Case' 0\nfileread fh 3 s\nfileclose fh\n${write('s')}`, files))).toBe('hel');
    expect(out(run(`fileopen fh 'C:\\DATA.BIN' 0\nfileread fh 4 s\nfileclose fh\n${write('s')}`, files))).toBe('A');
    // filecreate truncates, filewrite appends, literals and variables both work
    const w = run(`filecreate fh 'A:\\Dir\\Mixed.Case'\nfilewrite fh 'ab'\ns = 'cd'\nfilewrite fh s\nfileclose fh\n`, files);
    expect(str(w.fs.files.get('A:\\Dir\\Mixed.Case'))).toBe('abcd');
    expect(w.trace).toEqual(['filecreate A:\\Dir\\Mixed.Case -> 0', "filewrite A:\\Dir\\Mixed.Case 'ab'", "filewrite A:\\Dir\\Mixed.Case 'cd'", 'fileclose A:\\Dir\\Mixed.Case']);
    // filecopy overwrites, takes literals or variables, and does nothing when the source is missing
    const c = run(`src = 'C:\\DATA.BIN'\nfilecopy src 'A:\\Dir\\Mixed.Case'\nfilecopy 'C:\\NOPE' 'C:\\DATA.BIN'\nfilecopy 'C:\\DATA.BIN' 'C:\\NEW.BIN'\n`, files);
    expect(Array.from(c.fs.files.get('A:\\Dir\\Mixed.Case') as Uint8Array)).toEqual([0x41, 0x00, 0xe1, 0x42]);
    expect(Array.from(c.fs.files.get('C:\\NEW.BIN') as Uint8Array)).toEqual([0x41, 0x00, 0xe1, 0x42]);
    expect(Array.from(c.fs.files.get('C:\\DATA.BIN') as Uint8Array)).toEqual([0x41, 0x00, 0xe1, 0x42]);
    expect(c.trace[1]).toBe('filecopy C:\\NOPE C:\\DATA.BIN -> source missing');
    // strcompare: 0 when equal
    const cmp = (a: string, b: string) => out(run(`a = '${a}'\nstrcompare a '${b}'\nr = 'different'\nif result = 0 then\n    r = 'equal'\nendif\n${write('r')}`));
    expect(cmp('abc', 'abc')).toBe('equal');
    expect(cmp('abc', 'abd')).toBe('different');
  });

  it('str2code on an empty string: 0 by default, optionally leaves the variable unchanged', () => {
    const script = `code = 7\ns = ''\nstr2code code s\nr = 'other'\nif code = 0 then\n    r = 'zero'\nendif\nif code = 7 then\n    r = 'kept'\nendif\n${write('r')}`;
    const go = (emptyStr2code?: 'zero' | 'unchanged') => {
      const fs: SimFs = { files: new Map() };
      expect(runScript(script, fs, emptyStr2code ? { emptyStr2code } : undefined).error).toBeUndefined();
      return str(fs.files.get('C:\\OUT.TXT'));
    };
    expect(go()).toBe('zero');
    expect(go('zero')).toBe('zero');
    expect(go('unchanged')).toBe('kept');
  });

  it('integer comparisons, nested if and goto', () => {
    const verdict = (a: number, op: string, b: number) => out(run(`a = ${a}\nr = 'F'\nif a ${op} ${b} then\n    r = 'T'\nendif\n${write('r')}`));
    expect([verdict(1, '=', 1), verdict(1, '=', 2), verdict(1, '<>', 2), verdict(2, '<>', 2)].join('')).toBe('TFTF');
    expect([verdict(-1, '<', 0), verdict(0, '<', 0), verdict(5, '>', 4), verdict(4, '>', 4)].join('')).toBe('TFTF');
    const nested = (a: number, b: number) =>
      out(run(`a = ${a}\nb = ${b}\nr = 'none'\nif a = 1 then\n    r = 'outer'\n    if b = 1 then\n        r = 'inner'\n    endif\nendif\n${write('r')}`));
    expect([nested(1, 1), nested(1, 0), nested(0, 1)]).toEqual(['inner', 'outer', 'none']);
    // goto out of an if block, to a label later in the file
    expect(out(run(`a = 1\nr = 'fell'\nif a = 1 then\n    goto skip\nendif\nr = 'not skipped'\n:skip\n${write('r')}`))).toBe('fell');
    // commands and variables are case-insensitive, as in Tera Term
    expect(out(run(`A = 1\nR = 'F'\nIF a = 1 THEN\n    r = 'T'\nENDIF\n${write('R')}`))).toBe('T');
  });
});
