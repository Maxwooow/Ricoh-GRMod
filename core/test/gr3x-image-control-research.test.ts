// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { importGr3xCube, previewGr3xCube } from '../src/color/gr3x-import';
import { buildGr3xLookMenuResearch } from '../src/fw/gr3x/image-control-research';
import { buildGr3xAdjResearch } from '../src/fw/gr3x/adj';

const channelSwap = 'TITLE "Channel test"\nLUT_3D_SIZE 2\n' +
  ['0 0 0', '0 0 1', '0 1 0', '0 1 1', '1 0 0', '1 0 1', '1 1 0', '1 1 1'].join('\n') + '\n';

describe('IIIx lossless CUBE intake, separate from GR IV fitting', () => {
  it('retains the original LUT and evaluates its channel order without GR IV calibration', async () => {
    const imported = await importGr3xCube(channelSwap, 'srgb-display');
    expect(imported.sourceText).toBe(channelSwap);
    expect(imported).toMatchObject({ firmwareEncoding: 'matrix-rgb-curve-fit', cameraRenderingVerified: false, size3D: 2 });
    const output = await previewGr3xCube(imported, Float64Array.of(.2, .4, .8, 1, 0, 0));
    [.8, .4, .2, 0, 0, 1].forEach((v, i) => expect(output[i]).toBeCloseTo(v, 12));
  });
  it('rejects changed source and invalid RGB rather than presenting a misleading preview', async () => {
    const imported = await importGr3xCube(channelSwap, 'srgb-display');
    await expect(previewGr3xCube({ ...imported, sourceText: channelSwap.replace('0 0 1', '0 0 .5') }, Float64Array.of(1, 0, 0)))
      .rejects.toMatchObject({ code: 'bad-input' });
    await expect(previewGr3xCube(imported, Float64Array.of(NaN, 0, 0))).rejects.toMatchObject({ code: 'bad-input' });
    await expect(previewGr3xCube(imported, Float64Array.of(0, 0))).rejects.toMatchObject({ code: 'bad-input' });
    await expect(importGr3xCube(channelSwap, 'log' as 'srgb-display')).rejects.toMatchObject({ code: 'bad-input' });
  });
});

const input = process.env.GRMOD_GR3X_FIRMWARE;
describe.skipIf(!input)('IIIx isolated extra-look menu experiment', () => {
  let original: Awaited<ReturnType<typeof buildGr3xAdjResearch>>;
  let added: Awaited<ReturnType<typeof buildGr3xLookMenuResearch>>;
  beforeAll(async () => {
    const raw = new Uint8Array(readFileSync(input!));
    original = await buildGr3xAdjResearch(raw);
    const logo = new Uint8Array(6400);
    for (let i = 0; i < logo.length; i += 4) { logo[i] = 222; logo[i + 3] = 255; }
    added = await buildGr3xLookMenuResearch(raw, [{ name: 'Film Test', source: 'cube', icon: logo }, { name: 'M Standard', source: 'gr4m-research' }]);
  }, 60000);
  it('retains every T4 image, live-view, RAW and ratio patch', () => {
    expect(added.ratios).toEqual(original.ratios);
    expect(added.append.bytes.startsWith(original.append.bytes)).toBe(true);
    for (const site of original.sites) {
      if (/extended IIIx (language directory|text bound|icon directory|icon bound)/.test(site.reason)) continue;
      expect(added.sites.find(s => s.address === site.address)).toEqual(site);
    }
    expect(added.iconAddition.bytes.startsWith(original.iconAddition.bytes)).toBe(true);
    expect(added.kind).toBe('gr3x-image-control-menu-research');
    expect(added).toMatchObject({ firmwareGenerated: false, flashable: false, cameraUpdateCandidate: false,
      renderingImplemented: false, persistenceImplemented: false });
  });
  it('reserves separate identities and describes the unfinished capture path explicitly', () => {
    expect(added.addedLooks.map(x => x.id)).toEqual([64, 65]);
    expect(added.catalogs.textColumns).toBe(original.catalogs.textColumns + 2);
    expect(added.catalogs.iconCount).toBe(original.catalogs.iconCount + 2);
    expect(added.blockers.some(x => x.includes('ISP'))).toBe(true);
    expect(added.addedLooks.every(x => !x.renderingImplemented)).toBe(true);
  });
  it('rejects malformed names, duplicate entries and oversized catalogs before reading firmware', async () => {
    const raw = new Uint8Array();
    for (const name of ['', 'A\nB', 'x'.repeat(25), '\ud800'])
      await expect(buildGr3xLookMenuResearch(raw, [{ name, source: 'cube' }])).rejects.toMatchObject({ code: 'bad-edit' });
    await expect(buildGr3xLookMenuResearch(raw, [{ name: 'Film', source: 'cube' }, { name: 'Film', source: 'cube' }]))
      .rejects.toMatchObject({ code: 'bad-edit' });
  });
});
