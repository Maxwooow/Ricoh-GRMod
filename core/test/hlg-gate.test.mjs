// SPDX-License-Identifier: GPL-2.0-only
// @mock-exempt: engine worker, host bridge, pixels and preview are external boundaries (same pattern as gr3x-ui.test.mjs)
// The HLG photo mode is offered only by GR IV programs that carry its code (DEC-HLG-121-001 in
// core/src/app/engine.ts). Since upstream 0.8.16, 1.21 runs 1.20's modules with its own addresses, so the 1.20
// module (DEC-HLG-121-002 in core/src/fw/gr4v120/aspect/hlg.ts) covers it; the gate stays for any later program.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Gr4Program111 from '../src/fw';
import * as Gr4Program120 from '../src/fw/gr4v120';
import * as Gr4Program121 from '../src/fw/gr4v121';

const mocks = vi.hoisted(() => ({
  engine: { open: vi.fn(), reset: vi.fn(), build: vi.fn(), ratio: vi.fn(), inspect: vi.fn(), heartbeat: vi.fn() },
  host: { available: false, info: { token: 'test', kind: 'test' }, storeGet: vi.fn(), storeSet: vi.fn(), storeDel: vi.fn(), volumes: vi.fn(), sidecar: vi.fn(), join: (...p) => p.join('/') },
}));
vi.mock('../../ui/src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error {} }));
vi.mock('../../ui/src/host', () => ({ host: mocks.host, HostError: class extends Error {}, sha256Hex: async () => 'test-hash', isAndroid: false, isMobile: false }));
vi.mock('../../ui/src/pixels', () => ({ ensureIconFont: vi.fn() }));
vi.mock('../../ui/src/preview', () => ({ decodePreview: vi.fn() }));

const hasHlg = (program) => typeof program.aspect.installHlgPhoto === 'function';

describe('HLG photo mode per GR IV program', () => {
  it('1.11, 1.20 and 1.21 carry the HLG code', () => {
    expect(hasHlg(Gr4Program111)).toBe(true);
    expect(hasHlg(Gr4Program120)).toBe(true);
    expect(hasHlg(Gr4Program121)).toBe(true);
  });
  it('1.21 keeps 1.20\'s icon numbers, so its HDR scale is the same icon', () => {
    expect(Gr4Program120.aspect.HDR_SCALE_ICON_ID).toBe(800);
    expect(Gr4Program121.aspect.HDR_SCALE_ICON_ID).toBe(800);
  });
});

describe('the UI only sends HLG where the open firmware offers it', () => {
  let store;
  beforeEach(async () => { vi.resetModules(); vi.stubGlobal('document', { hidden: true }); store = await import('../../ui/src/store'); });
  const base = { hlgPhoto: true, model: 'HDF' };
  it('is on for a GR IV file whose features include hlgPhoto', () => {
    expect(store.hlgPhotoOn({ ...base, info: { family: 'gr4', features: { hlgPhoto: true } } })).toBe(true);
  });
  it('is off for a file without the hlgPhoto feature, even with the switch saved on in the project', () => {
    expect(store.hlgPhotoOn({ ...base, info: { family: 'gr4', features: { hdrGainMap: true } } })).toBe(false);
  });
  it('stays off for the Monochrome and with nothing open', () => {
    expect(store.hlgPhotoOn({ ...base, model: 'MONO', info: { family: 'gr4', features: { hlgPhoto: true } } })).toBe(false);
    expect(store.hlgPhotoOn({ ...base, info: undefined })).toBe(false);
  });
});
