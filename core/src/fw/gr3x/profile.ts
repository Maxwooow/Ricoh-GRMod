// SPDX-License-Identifier: GPL-2.0-only
/** GR IIIx 1.60 is shared by the standard, Urban and HDF cameras; GR III 2.10 by the standard,
 * Street, Diary and HDF cameras. Both are the same build of one program: every function and data
 * address is identical, and the two images differ only in ~30 identity bytes (camera name, project
 * and product number, version, build time, the RTC epoch year). The IIIx port is therefore used
 * unchanged on GR III 2.10; GR III is EXPERIMENTAL (no camera test yet). A firmware file cannot
 * prove which physical variant is connected. No GR IV patch address is used here. */
import { Firmware, FirmwareError, sectionsOf, sha256Hex } from '../container';

export interface Gr3Profile {
  readonly id: string; readonly model: 'GR3X_HDF' | 'GR3_HDF'; readonly camera: string; readonly tag: string;
  /** The standard camera's model key: the same official file (Ricoh's archive applies to every edition). */
  readonly standardModel: 'GR3X' | 'GR3';
  readonly version: string; readonly internalVersion: string; readonly versionWord: number;
  readonly filename: string; readonly size: number; readonly decodedSize: number;
  readonly sha256: string; readonly decodedSha256: string; readonly rtosSha256: string;
  readonly project: number; readonly product: number;
  readonly rtosOffset: number; readonly rtosLength: number; readonly rtosBase: number;
  readonly ramSource: number; readonly ramBase: number; readonly ramLength: number;
  readonly factoryRatios: readonly ['3:2', '1:1'];
  readonly buildEnabled: boolean; readonly buildRecipe: string;
  /** Every feature (up to 20 films with Halation in the camera, the date imprint, End Screen pictures,
   * the Image Control order): made and tested on GR III 2.10, the same program as GR IIIx 1.60
   * (core/test/gr3-equivalence.test.ts builds every one of them for both and compares). */
  readonly fullFeatures: boolean;
}

export const GR3X_160 = {
  id: 'gr3x-hdf-1.60', model: 'GR3X_HDF', standardModel: 'GR3X', camera: 'GR IIIx', tag: 'GR3X-HDF-160',
  version: '1.60', internalVersion: '1.60.11.17', versionWord: 0x013c0b11,
  filename: 'fwdc243b.bin', size: 30391788, decodedSize: 59718388,
  sha256: '708e79f3b7b96a7e1581b4acf4c412233050a1832718ef7f06c8397db1b431c7',
  decodedSha256: 'c4bfc09d1148deec2155b21bd3d63be8085cf835cbe5e5cde4832747f519e630',
  rtosSha256: '0f11b0d28bc67932d044c5d01bc0314844a756057c89984278c73a23449a24c6',
  project: 609, product: 78490, rtosOffset: 0x10870, rtosLength: 17520064, rtosBase: 0x53000000,
  ramSource: 0x5407b540, ramBase: 0x55000000, ramLength: 0x3a080,
  factoryRatios: ['3:2', '1:1'],
  buildEnabled: true, buildRecipe: 'fixed-adj9-T4', fullFeatures: true,
} as const satisfies Gr3Profile;

/** GR III 2.10 (fwdc239b.bin). Layout fields must equal GR3X_160's: they are asserted below and in
 * the tests, and every address in this directory relies on it. */
export const GR3_210 = {
  ...GR3X_160,
  id: 'gr3-hdf-2.10', model: 'GR3_HDF', standardModel: 'GR3', camera: 'GR III', tag: 'GR3-HDF-210',
  version: '2.10', internalVersion: '2.10.21.27', versionWord: 0x020a151b,
  filename: 'fwdc239b.bin', size: 30391780,
  sha256: 'd6a3c9c288d784080e7b283222ecdd8752adfeed6faa36dab44f73115354bfd4',
  decodedSha256: '53da690797f35ad6dc2c429d8ca1d0de8e333c211ed959816813982cd093b703',
  rtosSha256: '8a4eafcad2716e0b21e9909264e1242e534f0e39e05cba82a53546ceb4070b67',
  project: 588, product: 78350, fullFeatures: true,
} as const satisfies Gr3Profile;

export const GR3_PROFILES: readonly Gr3Profile[] = [GR3X_160, GR3_210];

/** The profile whose exact official file this is (size and SHA-256), or null. */
export async function gr3ProfileOf(raw: Uint8Array): Promise<Gr3Profile | null> {
  const candidates = GR3_PROFILES.filter(p => p.size === raw.length);
  if (!candidates.length) return null;
  const sha = await sha256Hex(raw);
  return candidates.find(p => p.sha256 === sha) ?? null;
}

export const GR3X_SYMBOLS = {
  dimensions: { address: 0x536a2a30, evidence: 'native-executed' },
  preview: { address: 0x5366632c, evidence: 'native-executed' },
  dngWindow: { address: 0x53661054, evidence: 'native-executed' },
  aspectGetter: { address: 0x53245260, evidence: 'native-executed' },
  aspectSetter: { address: 0x532525a4, evidence: 'native-executed-through-property-transaction' },
  aspectCycle: { address: 0x53227114, evidence: 'native-executed' },
  adjAspectCount: { address: 0x5319fea0, evidence: 'native-executed-with-ui-and-storage-substitutes' },
  menuAspectCount: { address: 0x531b3aac, evidence: 'native-executed-with-ui-and-storage-substitutes' },
  imageAspectWriter: { address: 0x53604a44, evidence: 'patched-native-executed-all-byte-values' },
  imageAspectReader: { address: 0x535ed438, evidence: 'patched-native-executed-all-byte-values' },
  updaterVersionCheck: { address: 0x536284e0, evidence: 'native-executed-equal-version-accepted' },
  rearDial: { address: 0x53295da0, evidence: 'native-executed-synthetic-state-physical-mapping-unverified' },
} as const;

export const GR3X_BLOCKERS = [
  'arbitrary-ratio-and-other-feature-ports', 'T6-nine-films-hardware-test',
  'power-cycle-and-user-mode-storage', 'complete-ISP-mode-coverage',
] as const;

export function gr3xOffset(va: number): number {
  const p = GR3X_160;
  if (!Number.isSafeInteger(va)) throw new FirmwareError('bad-address', 'invalid address');
  if (va >= p.ramBase && va < p.ramBase + p.ramLength) va = p.ramSource + va - p.ramBase;
  if (va < p.rtosBase || va >= p.rtosBase + p.rtosLength) throw new FirmwareError('bad-address', 'outside GR IIIx RTOS');
  return p.rtosOffset + va - p.rtosBase;
}

export async function openGr3xOfficial(raw: Uint8Array): Promise<{ fw: Firmware; decoded: Uint8Array; profile: Gr3Profile }> {
  const p = await gr3ProfileOf(raw);
  if (!p) {
    throw new FirmwareError('unsupported-firmware', 'GR III / IIIx support requires the exact official GR IIIx 1.60 fwdc243b.bin or GR III 2.10 fwdc239b.bin');
  }
  // The shared addresses are only valid for this exact layout.
  const L = GR3X_160;
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
