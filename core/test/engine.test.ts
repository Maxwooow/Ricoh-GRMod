import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine, SHUTDOWN_H, SHUTDOWN_W, card, fw, jpeg, wallpaper } from '../src';

const P = new URL('../testdata/private/', import.meta.url).pathname;

/** Change one more word so that the 32-bit word sum of the payload is zero again (as a foreign tool would). */
function fixSum(d: Uint8Array): Uint8Array {
  const sum = fw.sum32(d);
  const o = 0x900010;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  dv.setUint32(o, (dv.getUint32(o, true) - sum) >>> 0, true);
  return d;
}
const have = existsSync(P + 'official.bin');
const OUT = '/tmp/claude-0/-home-claude/88a14fdf-ef79-5caf-8cde-fe4ab6536e46/scratchpad/e2e/';

describe.skipIf(!have)('engine end to end', () => {
  let eng: Engine;
  it('opens the official file and reports what the UI needs', async () => {
    eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const info = eng.info;
    expect(info.version).toBe('1.11');
    expect(info.slots.map((s) => s.id)).toEqual(['CY', 'CG']);
    expect(info.slots[0].names['zh-CN']).toEqual({ text: '电影（黄色）', capacity: 6 });
    expect(info.slots[1].names.en).toEqual({ text: 'Cinema (Green)', capacity: 14 });
    expect(info.shutdown.HDF).toMatchObject({ size: 56842, sampling: '422' });
    expect(info.shutdown.MONO).toMatchObject({ size: 56571, sampling: '422' });
    expect(info.shutdown.STANDARD).toMatchObject({ size: 7264, sampling: '420' });
    expect(info.allowed['zh-CN']).toContain('全');
    expect(info.tiles.film.length).toBe(6400);
  });
  it('rejects anything that is not the official file', async () => {
    const bad = new Uint8Array(readFileSync(P + 'B.bin'));
    await expect(Engine.open(bad)).rejects.toMatchObject({ code: 'unsupported-firmware' });
    await expect(Engine.open(new Uint8Array(1000))).rejects.toBeInstanceOf(fw.FirmwareError);
  });
  it('converts presets, builds a firmware with names and icons, and the result passes the self-check', async () => {
    const a = eng.convertPreset('xmp', readFileSync(P + 'q400.xmp', 'utf8'));
    const b = eng.convertPreset('xmp', readFileSync(P + 'c200.xmp', 'utf8'));
    expect(a.meanDE).toBeLessThan(2.7);
    expect(b.meanDE).toBeLessThan(3.25);
    const cov = new Float32Array(1600);
    for (let y = 14; y < 26; y++) for (let x = 8; x < 32; x++) cov[y * 40 + x] = (x + y) % 3 === 0 ? 1 : 0.4;
    const iconA = fw.composeIcon(eng.info.tiles.film, cov);
    const iconB = fw.composeIcon(eng.info.tiles.plain, cov);
    expect(eng.validateName('CY', 'zh-CN', '全能400').ok).toBe(true);
    expect(eng.validateName('CG', 'zh-CN', 'SP3000&C200')).toMatchObject({ ok: false, reason: 'too-long', capacity: 6 });
    const res = await eng.buildFirmware([
      { slot: 'CY', preset: a, icon: iconA, names: { 'zh-CN': '全能400', en: 'Film 400' } },
      { slot: 'CG', preset: b, icon: iconB, names: { 'zh-CN': 'C200', en: 'C200' } },
    ]);
    expect(Object.values(res.checks).every((v) => v === true)).toBe(true);
    expect(res.file.length).toBeGreaterThan(38_000_000);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(OUT + 'ts_full.bin', res.file);
    writeFileSync(OUT + 'ts_full.json', JSON.stringify({ sha256: res.sha256, ranges: res.ranges, changedFrames: res.changedFrames, changedBytes: res.changedBytes,
      q400: { matrix: Array.from(a.matrixQ13), R: Array.from(a.curves[0]), G: Array.from(a.curves[1]), B: Array.from(a.curves[2]) },
      c200: { matrix: Array.from(b.matrixQ13), R: Array.from(b.curves[0]), G: Array.from(b.curves[1]), B: Array.from(b.curves[2]) } }));
    // an icon-only and a name-only build also work
    const r2 = await eng.buildFirmware([{ slot: 'CG', icon: iconA }]);
    expect(Object.values(r2.checks).every(Boolean)).toBe(true);
    const r3 = await eng.buildFirmware([{ slot: 'CY', names: { ja: 'フィルム' } }]);
    expect(Object.values(r3.checks).every(Boolean)).toBe(true);
    await expect(eng.buildFirmware([{ slot: 'CY' }])).rejects.toMatchObject({ code: 'bad-edit' });
  });
  it('encodes power-off images of the exact factory size, with grain or softening when needed', () => {
    const n = SHUTDOWN_W * SHUTDOWN_H;
    const photo = new Uint8Array(n * 3);
    for (let y = 0; y < SHUTDOWN_H; y++) for (let x = 0; x < SHUTDOWN_W; x++) {
      const i = (y * SHUTDOWN_W + x) * 3; const v = 128 + 90 * Math.sin(x / 9) * Math.cos(y / 13) + 30 * Math.sin((x * y) / 700);
      photo[i] = v; photo[i + 1] = v * 0.9 + 10; photo[i + 2] = 200 - v * 0.5;
    }
    const flat = new Uint8Array(n * 3).fill(90);
    for (let y = 100; y < 300; y++) for (let x = 200; x < 520; x++) { const i = (y * SHUTDOWN_W + x) * 3; flat[i] = 230; flat[i + 1] = 228; flat[i + 2] = 220; }
    for (const model of ['HDF', 'MONO'] as const) {
      const size = eng.info.shutdown[model]!.size;
      const p = eng.encodeShutdownImage(photo, model);
      expect(p.data.length).toBe(size);
      expect(jpeg.checkShutdownJpeg(p.data, { byteLength: size, sampling: '422' }).ok).toBe(true);
      const f = eng.encodeShutdownImage(flat, model);
      expect(f.data.length).toBe(size);
      expect(f.grain).toBeGreaterThan(0);
      expect(f.preview.length).toBe(n * 3);
    }
    const std = eng.encodeShutdownImage(photo, 'STANDARD');
    expect(std.data.length).toBe(7264);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(OUT + 'flat_hdf.jpg', eng.encodeShutdownImage(flat, 'HDF').data);
  });
  it('describes firmware files found on a card', async () => {
    const official = await eng.inspect(new Uint8Array(readFileSync(P + 'official.bin')));
    expect(official.kind).toBe('official');
    expect(official.changedBytes).toBe(0);
    expect(official.slots.map((s) => [s.id, s.names.en, s.colorChanged, s.nameChanged, s.iconChanged])).toEqual([['CY', 'Cinema (Yellow)', false, false, false], ['CG', 'Cinema (Green)', false, false, false]]);

    // test firmware C of the earlier hand-made set: both presets and both icons, names untouched
    const c = await eng.inspect(new Uint8Array(readFileSync(P + 'C.bin')));
    expect(c.kind).toBe('modified');
    expect(c.verified).toBe(true);
    expect(official.verified).toBe(true);
    expect(c.changedBytes).toBeGreaterThan(1000);
    expect(c.slots.map((s) => [s.id, s.colorChanged, s.nameChanged, s.iconChanged])).toEqual([['CY', true, false, true], ['CG', true, false, true]]);
    expect(c.slots[0].icon.length).toBe(40 * 40 * 4);
    const a = await eng.inspect(new Uint8Array(readFileSync(P + 'A.bin')));
    expect(a.slots.map((s) => [s.colorChanged, s.iconChanged])).toEqual([[true, false], [false, false]]); // A changes one slot only
    const b = await eng.inspect(new Uint8Array(readFileSync(P + 'B.bin')));
    expect(b.slots.map((s) => [s.colorChanged, s.iconChanged])).toEqual([[true, false], [true, false]]);

    // a file built here with a new name
    const built = await eng.buildFirmware([{ slot: 'CG', names: { en: 'C200' } }]);
    const mine = await eng.inspect(built.file);
    expect(mine.kind).toBe('modified');
    expect(mine.verified).toBe(true);
    // everything at once (names in two languages, both icons, both presets) is still inside the editable ranges
    const q = await eng.convertPreset('xmp', readFileSync(P + 'q400.xmp', 'utf8'));
    const iconA = eng.info.tiles.film.slice(); const iconB = eng.info.tiles.plain.slice();
    const full = await eng.buildFirmware([
      { slot: 'CY', preset: { matrixQ13: q.matrixQ13, curves: q.curves }, names: { en: 'Q400', ja: 'Q400' }, icon: iconA },
      { slot: 'CG', preset: { matrixQ13: q.matrixQ13, curves: q.curves }, names: { en: 'C200', 'zh-CN': 'C200' }, icon: iconB },
    ]);
    expect((await eng.inspect(full.file)).verified).toBe(true);
    // a valid container with a change outside those ranges is recognised as modified but not verified
    const foreign = new Uint8Array(readFileSync(P + 'official.decoded'));
    foreign[0x900000] ^= 1; // one byte of code; fixSum() balances the checksum in another word
    const rebuilt = fw.build(new fw.Firmware(new Uint8Array(readFileSync(P + 'official.bin'))), fixSum(foreign));
    const f2 = await eng.inspect(rebuilt.out);
    expect(f2.kind).toBe('modified');
    expect(f2.verified).toBe(false);
    expect(mine.slots[1].names.en).toBe('C200');
    expect(mine.slots.map((s) => [s.colorChanged, s.nameChanged, s.iconChanged])).toEqual([[false, false, false], [false, true, false]]);

    expect(a.verified && b.verified).toBe(true);
    // damaged or foreign files are reported, not thrown
    const cut = new Uint8Array(readFileSync(P + 'C.bin')).subarray(0, 5_000_000);
    expect((await eng.inspect(cut)).kind).toBe('unknown');
    const flipped = new Uint8Array(readFileSync(P + 'C.bin')); flipped[20_000_000] ^= 0x10;
    expect((await eng.inspect(flipped)).kind).toBe('unknown');
    expect((await eng.inspect(new Uint8Array(64))).kind).toBe('unknown');
    expect((await eng.inspect(new TextEncoder().encode('; startup script'))).kind).toBe('unknown');
  });

  it('finds the factory-menu entry files in the firmware', () => {
    const fe = eng.info.factoryEntry;
    expect(fe.modeSetName).toBe('00078560.636');
    expect(fe.keyName).toBe('DEVELOP.MOD');
    expect(fe.files.map((f) => f.name)).toEqual(['DEVELOP.MOD', '00078560.636']);
    expect(fe.files[0].data.length).toBe(10);
    expect(createHash('sha256').update(fe.files[0].data).digest('hex')).toBe('0d622b3b4e26b183a0434f876f33cf56787c9b37c9b05e850f4be4a15c8ccf2d');
    expect(Buffer.from(fe.files[1].data).toString('latin1')).toBe('[OPEN_FACTORY_DEBUG_MENU]\r\n');
    // the names agree with the ones a firmware card moves aside
    expect([...card.FACTORY_ENTRY_FILES].sort()).toEqual(fe.files.map((f) => f.name).sort());

    const listing: card.CardListing = { root: [{ name: 'fwdc248b.bin', dir: false, size: 1 }, { name: 'develop.mod', dir: false, size: 10 }, { name: 'script', dir: true, size: 0 }], script: [{ name: 'startup.ttl', dir: false, size: 5 }] };
    expect(card.hasEntryFiles(listing)).toBe(false);
    const plan = card.planEntryCard(listing, fe.files, '20260101-000000');
    expect(plan[0]).toEqual({ op: 'move', from: ['fwdc248b.bin'], to: ['GRMOD', 'parked-20260101-000000', 'fwdc248b.bin'] });
    expect(plan.slice(1).map((s) => (s.op === 'write' ? s.path.join('/') : ''))).toEqual(['develop.mod', '00078560.636']);
    expect(plan.some((s) => s.op === 'move' && s.from[0] === 'script')).toBe(false); // the start-up script stays

    const after: card.CardListing = { root: [{ name: 'DEVELOP.MOD', dir: false, size: 10 }, { name: '00078560.636', dir: false, size: 27 }, { name: 'GBR1.JPG', dir: false, size: 9 }], script: [] };
    expect(card.hasEntryFiles(after)).toBe(true);
    // every other write clears the entry files away by itself
    const moves = (plan: card.PlanStep[]): string[] => plan.filter((s) => s.op === 'move').map((s) => (s.op === 'move' ? s.from.join('/') : ''));
    expect(moves(card.planFirmwareCard(after, new Uint8Array([1]), 's1'))).toEqual(['00078560.636', 'DEVELOP.MOD']);
    expect(moves(card.planWallpaperCard(after, [new Uint8Array([1])], '; x', 's1'))).toEqual(['00078560.636', 'DEVELOP.MOD']);
    expect(moves(card.planRestoreWallpaper(after, { script: new Uint8Array([59]), images: [{ name: 'GBR1.JPG', data: new Uint8Array([1]) }] }, 's1'))).toEqual(['00078560.636', 'DEVELOP.MOD']);
    const moved = card.planWallpaperCard(after, [new Uint8Array([1])], '; x', 's1')[0];
    expect(moved).toEqual({ op: 'move', from: ['00078560.636'], to: ['GRMOD', 'parked-s1', '00078560.636'] });
    expect(moves(card.planWallpaperCard({ root: [], script: [] }, [new Uint8Array([1])], '; x', 's1'))).toEqual([]);
  });

  it('plans the card layouts', () => {
    const script = eng.rotationScript('HDF', 3);
    expect(script).toContain('56842');
    const imgs = [new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)];
    const listing = { root: [{ name: 'FWDC248B.BIN', dir: false, size: 1 }, { name: 'DCIM', dir: true, size: 0 }, { name: 'GBRSTOP.TXT', dir: false, size: 0 }], script: [] };
    expect(card.cardRole(listing)).toBe('firmware');
    const w = card.planWallpaperCard(listing, imgs, script, '20260101-000000');
    expect(w.filter((s) => s.op === 'move').map((s) => (s as any).from.join('/'))).toEqual(['FWDC248B.BIN', 'GBRSTOP.TXT']);
    expect(w[w.length - 1]).toMatchObject({ op: 'write', path: ['script', 'startup.ttl'] });
    const l2 = { root: [{ name: '00078560.636', dir: false, size: 27 }, { name: 'DEVELOP.MOD', dir: false, size: 10 }, { name: 'GBR1.JPG', dir: false, size: 5 }, { name: 'script', dir: true, size: 0 }], script: [{ name: 'startup.ttl', dir: false, size: 99 }] };
    expect(card.cardRole(l2)).toBe('wallpaper');
    const f = card.planFirmwareCard(l2, new Uint8Array(8), 's1');
    expect(f.map((s) => s.op)).toEqual(['move', 'move', 'move', 'write']);
    expect((f[0] as any).to).toEqual(['GRMOD', 'parked-s1', 'script', 'startup.ttl']);
    expect(card.cardRole({ root: [], script: [] })).toBe('empty');
    // a remembered setup goes back verbatim; the index on the card is kept, the firmware file is moved aside
    const snap = { script: new TextEncoder().encode('; old script\nexit\n'), images: [{ name: 'GBR1.JPG', data: new Uint8Array(3) }, { name: 'gbr2.jpg', data: new Uint8Array(4) }], index: new Uint8Array([0x32]) };
    const afterFw = { root: [{ name: 'fwdc248b.bin', dir: false, size: 9 }, { name: 'GBR1.JPG', dir: false, size: 3 }, { name: 'GBRIDX.TXT', dir: false, size: 1 }, { name: 'script', dir: true, size: 0 }], script: [] };
    expect(card.hasWallpaperScript(afterFw)).toBe(false);
    expect(card.wallpaperImageNames(afterFw)).toEqual(['GBR1.JPG']);
    const rs = card.planRestoreWallpaper(afterFw, snap, 's2');
    expect(rs.map((x) => x.op === 'move' ? 'move ' + x.from.join('/') : 'write ' + x.path.join('/'))).toEqual(['move fwdc248b.bin', 'write GBR1.JPG', 'write GBR2.JPG', 'write script/startup.ttl']);
    const blank = card.planRestoreWallpaper({ root: [], script: [] }, snap, 's3');
    expect(blank.map((x) => x.op === 'move' ? 'move' : x.path.join('/'))).toEqual(['GBR1.JPG', 'GBR2.JPG', 'GBRIDX.TXT', 'script/startup.ttl']);
    expect((blank[2] as any).data).toEqual(new Uint8Array([0x32]));
    expect(() => card.planRestoreWallpaper(afterFw, { ...snap, images: [{ name: 'evil.exe', data: new Uint8Array(1) }] }, 's4')).toThrow();
    // the generated script behaves in the simulator with the factory image as the internal file
    const files = new Map<string, Uint8Array>();
    files.set('E:\\BlkCtl15.bin', new Uint8Array([0xa5, 0x5a, 0x5a, 0xa5, 0xe1, 0x32, 0x01, 0x00]));
    files.set(wallpaper.MODEL_INFO.HDF.target, eng.info.shutdown.HDF!.data);
    for (let i = 1; i <= 3; i++) files.set(`C:\\GBR${i}.JPG`, new Uint8Array(56842).fill(i));
    for (const expectImg of [1, 2, 3, 1]) {
      const r = wallpaper.runScript(script, { files });
      expect(r.error).toBeUndefined();
      expect(files.get(wallpaper.MODEL_INFO.HDF.target)![0]).toBe(expectImg);
    }
  });
});
