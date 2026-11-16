// SPDX-License-Identifier: GPL-2.0-only
// What the UI offers per model (releases.gen.ts, from releases.json) is what the engine can open.
import { describe, expect, it } from 'vitest';
import { FIRMWARE_VERSION, FIRMWARE_VERSION_120, FIRMWARE_VERSION_121, GR3_210, GR3_220, GR3_221, GR3X_160, GR3X_170, GR3X_171 } from '@grmod/core';
import { SUPPORTED_LINES, SUPPORTED_RELEASES } from '../src/releases.gen';

describe('supported releases', () => {
  const gr4 = [FIRMWARE_VERSION_121, FIRMWARE_VERSION_120, FIRMWARE_VERSION];
  const gr3 = [GR3_221.version, GR3_220.version, GR3_210.version];
  const gr3x = [GR3X_171.version, GR3X_170.version, GR3X_160.version];
  it('each model lists the versions of the engine\'s programs, newest first', () => {
    expect([...SUPPORTED_RELEASES.STANDARD]).toEqual(gr4);
    expect([...SUPPORTED_RELEASES.HDF]).toEqual(gr4);
    expect([...SUPPORTED_RELEASES.GR3]).toEqual(gr3);
    expect([...SUPPORTED_RELEASES.GR3_HDF]).toEqual(gr3);
    expect([...SUPPORTED_RELEASES.GR3X]).toEqual(gr3x);
    expect([...SUPPORTED_RELEASES.GR3X_HDF]).toEqual(gr3x);
    // the GR IV Monochrome's releases are GR IV files under its own numbers: one per GR IV program after 1.11
    expect(SUPPORTED_RELEASES.MONO.length).toBe(gr4.length - 1);
  });
  it('the message for an unusable file names every camera line', () => {
    expect(SUPPORTED_LINES.map((l) => l.name)).toEqual(['GR IV', 'GR IV Monochrome', 'GR III', 'GR IIIx']);
  });
});
