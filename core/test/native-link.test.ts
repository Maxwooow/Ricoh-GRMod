// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, it } from 'vitest';
import { linkModule } from '../src/fw/aspect/native-link';
import type { NativeModule } from '../src/fw/aspect/native';
import { SLOT_PARAMS_MODULE } from '../src/fw/aspect/slotparams-native';
import { NATIVE } from '../src/fw/aspect/native';

// One `bl` (0xEB000000) at offset 0, relocated against the bound function `f`.
const module = (addend: number): NativeModule => ({
  bindings: ['f'],
  variants: { 1: { code: btoa(String.fromCharCode(0, 0, 0, 0xeb)), relocs: [[0, 'b', 'x', 0, addend]], exports: {} } },
} as unknown as NativeModule);

describe('linkModule', () => {
  it('a call into the firmware lands on the bound function', () => {
    const { code } = linkModule(module(0), 'test', 1, 0x54400000, { f: 0x538e09b0 });
    const word = new DataView(code.buffer).getUint32(0, true);
    let d = word & 0xffffff;
    if (d & 0x800000) d -= 1 << 24;
    expect((0x54400000 + 8 + d * 4) >>> 0).toBe(0x538e09b0);
  });

  it('refuses a call recorded beside its target (the fork\'s 7..12-slot variants: 8 bytes before)', () => {
    expect(() => linkModule(module(-8 >>> 0), 'test', 1, 0x54400000, { f: 0x538e09b0 })).toThrow(/does not land/);
  });

  it('every pre-compiled variant calls its bound functions exactly', () => {
    for (const mod of [SLOT_PARAMS_MODULE, ...Object.values(NATIVE)]) {
      for (const v of Object.values(mod.variants)) {
        for (const [, kind, where, , addend] of v.relocs) if (kind === 'b' && where === 'x') expect(addend).toBe(0);
      }
    }
  });
});
