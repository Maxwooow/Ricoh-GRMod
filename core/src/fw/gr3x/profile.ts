// SPDX-License-Identifier: GPL-2.0-only
/** The official files this release of the program accepts and how it opens them. The releases' own data
 * (hashes, sizes, layout) is in ../gr3-profiles.ts; GR3X_PROFILE and GR3_PROFILE are the two of the
 * release being built. No GR IV patch address is used here. */
import { Firmware, FirmwareError, sectionsOf, sha256Hex } from '../container';
import { GR3X_160, GR3X_170, GR3X_171, GR3_210, GR3_220, GR3_221 } from '../gr3-profiles';
import type { Gr3Profile } from '../gr3-profiles';
import { adr, byRelease } from './target';

export { GR3X_160, GR3X_170, GR3X_171, GR3_210, GR3_220, GR3_221 };
export type { Gr3Profile };

/** GR IIIx's and GR III's file of the release being built. */
export const GR3X_PROFILE: Gr3Profile = byRelease({ '1.60': GR3X_160, '1.70': GR3X_170, '1.71': GR3X_171 });
export const GR3_PROFILE: Gr3Profile = byRelease({ '1.60': GR3_210, '1.70': GR3_220, '1.71': GR3_221 });

export const GR3_PROFILES: readonly Gr3Profile[] = [GR3X_PROFILE, GR3_PROFILE];

/** The profile whose exact official file this is (size and SHA-256), or null. */
export async function gr3ProfileOf(raw: Uint8Array): Promise<Gr3Profile | null> {
  const candidates = GR3_PROFILES.filter(p => p.size === raw.length);
  if (!candidates.length) return null;
  const sha = await sha256Hex(raw);
  return candidates.find(p => p.sha256 === sha) ?? null;
}

export const GR3X_SYMBOLS = {
  dimensions: { address: adr(0x536a2a30), evidence: 'native-executed' },
  preview: { address: adr(0x5366632c), evidence: 'native-executed' },
  dngWindow: { address: adr(0x53661054), evidence: 'native-executed' },
  aspectGetter: { address: adr(0x53245260), evidence: 'native-executed' },
  aspectSetter: { address: adr(0x532525a4), evidence: 'native-executed-through-property-transaction' },
  aspectCycle: { address: adr(0x53227114), evidence: 'native-executed' },
  adjAspectCount: { address: adr(0x5319fea0), evidence: 'native-executed-with-ui-and-storage-substitutes' },
  menuAspectCount: { address: adr(0x531b3aac), evidence: 'native-executed-with-ui-and-storage-substitutes' },
  imageAspectWriter: { address: adr(0x53604a44), evidence: 'patched-native-executed-all-byte-values' },
  imageAspectReader: { address: adr(0x535ed438), evidence: 'patched-native-executed-all-byte-values' },
  updaterVersionCheck: { address: adr(0x536284e0), evidence: 'native-executed-equal-version-accepted' },
  rearDial: { address: adr(0x53295da0), evidence: 'native-executed-synthetic-state-physical-mapping-unverified' },
} as const;

export const GR3X_BLOCKERS = [
  'arbitrary-ratio-and-other-feature-ports', 'T6-nine-films-hardware-test',
  'power-cycle-and-user-mode-storage', 'complete-ISP-mode-coverage',
] as const;

export function gr3xOffset(va: number): number {
  const p = GR3X_PROFILE;
  if (!Number.isSafeInteger(va)) throw new FirmwareError('bad-address', 'invalid address');
  if (va >= p.ramBase && va < p.ramBase + p.ramLength) va = p.ramSource + va - p.ramBase;
  if (va < p.rtosBase || va >= p.rtosBase + p.rtosLength) throw new FirmwareError('bad-address', 'outside GR IIIx RTOS');
  return p.rtosOffset + va - p.rtosBase;
}

export async function openGr3xOfficial(raw: Uint8Array): Promise<{ fw: Firmware; decoded: Uint8Array; profile: Gr3Profile }> {
  const p = await gr3ProfileOf(raw);
  if (!p) {
    throw new FirmwareError('unsupported-firmware', `GR III / IIIx support requires the exact official GR IIIx ${GR3X_PROFILE.version} fwdc243b.bin or GR III ${GR3_PROFILE.version} fwdc239b.bin`);
  }
  // The shared addresses are only valid for this exact layout.
  const L = GR3X_PROFILE;
  if (p.rtosOffset !== L.rtosOffset || p.rtosLength !== L.rtosLength || p.rtosBase !== L.rtosBase || p.decodedSize !== L.decodedSize ||
      p.ramSource !== L.ramSource || p.ramBase !== L.ramBase || p.ramLength !== L.ramLength) {
    throw new FirmwareError('unexpected-layout', `${p.camera} layout differs from the verified shared layout`);
  }
  const fw = new Firmware(raw);
  const decoded = fw.decoded;
  const rtos = sectionsOf(decoded).find(s => s.name === 'RTOS');
  if (fw.project !== p.project || decoded.length !== p.decodedSize || await sha256Hex(decoded) !== p.decodedSha256 ||
      !rtos || rtos.offset !== p.rtosOffset || rtos.size !== p.rtosLength ||
      await sha256Hex(decoded.subarray(rtos.offset, rtos.offset + rtos.size)) !== p.rtosSha256) {
    throw new FirmwareError('unexpected-layout', `${p.camera} container or RTOS does not match the verified baseline`);
  }
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const startup = [p.ramSource, p.ramBase, p.ramLength];
  if (startup.some((v, i) => view.getUint32(p.rtosOffset + 0x450 + i * 4, true) !== v)) {
    throw new FirmwareError('unexpected-layout', `${p.camera} startup data map changed`);
  }
  // The RTOS header carries the identity the camera's updater and mode-set files use.
  if (view.getUint32(p.rtosOffset + 0x2030, true) !== p.project || view.getUint32(p.rtosOffset + 0x2034, true) !== p.product ||
      view.getUint32(p.rtosOffset + 0x2038, false) !== p.versionWord) {
    throw new FirmwareError('unexpected-layout', `${p.camera} RTOS header identity mismatch`);
  }
  return { fw, decoded, profile: p };
}

export function requireGr3xPort(feature: string): never {
  throw new FirmwareError('gr3x-port-incomplete', `GR III / IIIx: ${feature} is not ported; supported are fixed ADJ9, clarity soft focus and nine CUBE film slots`);
}
