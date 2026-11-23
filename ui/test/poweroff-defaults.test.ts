// SPDX-License-Identifier: GPL-2.0-only
// The built-in power-off pictures (poweroff-defaults.ts, DEC-POWEROFF-001): what the camera menu
// and the picture list need of them. The drawing itself is checked in a browser (Node has no canvas).
import { describe, expect, it } from 'vitest';
import { SHUTDOWN_MAX_PICTURES, SHUTDOWN_NAME_MAX, validateShutdownName } from '@grmod/core';
import { BUILT_IN_PICTURES } from '../src/poweroff-defaults';

describe('built-in power-off pictures', () => {
  it('fit the camera list: no more than it holds, distinct ids and names', () => {
    expect(BUILT_IN_PICTURES.length).toBe(8);
    expect(BUILT_IN_PICTURES.length).toBeLessThanOrEqual(SHUTDOWN_MAX_PICTURES);
    expect(new Set(BUILT_IN_PICTURES.map((p) => p.id)).size).toBe(BUILT_IN_PICTURES.length);
    expect(new Set(BUILT_IN_PICTURES.map((p) => p.name)).size).toBe(BUILT_IN_PICTURES.length);
  });
  it('each name is a valid camera-menu name as it is (the file name becomes the menu name)', () => {
    for (const p of BUILT_IN_PICTURES) {
      expect(p.name.length, p.name).toBeLessThanOrEqual(SHUTDOWN_NAME_MAX);
      expect(validateShutdownName(p.name), p.name).toBeNull();
    }
  });
  it('no design names Ricoh or GR in its picture', () => {
    // only the string literals of the drawing code: the words it puts on the picture
    for (const p of BUILT_IN_PICTURES) {
      const words = [...String(p.draw).matchAll(/(['"`])([^'"`\n]*)\1/g)].map((m) => m[2]);
      expect(words.length, p.name).toBeGreaterThan(0);
      for (const w of words) { expect(w, p.name).not.toMatch(/ricoh/i); expect(w, p.name).not.toMatch(/\bGR\b/); }
    }
  });
});
