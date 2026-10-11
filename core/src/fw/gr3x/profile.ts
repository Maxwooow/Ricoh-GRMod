// SPDX-License-Identifier: GPL-2.0-only
/** GR IIIx 1.60 is shared by the standard, Urban and HDF cameras. This port targets HDF;
 * a firmware file cannot prove which physical variant is connected. No GR IV patch address
 * is used here. The UI and test CLI share one fixed-nine recipe; unrelated features stay disabled. */
import { Firmware, FirmwareError, sectionsOf, sha256Hex } from '../container';

export const GR3X_160 = {
  id: 'gr3x-hdf-1.60', version: '1.60', internalVersion: '1.60.11.17',
  filename: 'fwdc243b.bin', size: 30391788, decodedSize: 59718388,
  sha256: '708e79f3b7b96a7e1581b4acf4c412233050a1832718ef7f06c8397db1b431c7',
  decodedSha256: 'c4bfc09d1148deec2155b21bd3d63be8085cf835cbe5e5cde4832747f519e630',
  rtosSha256: '0f11b0d28bc67932d044c5d01bc0314844a756057c89984278c73a23449a24c6',
  project: 609, rtosOffset: 0x10870, rtosLength: 17520064, rtosBase: 0x53000000,
  ramSource: 0x5407b540, ramBase: 0x55000000, ramLength: 0x3a080,
  factoryRatios: ['3:2', '1:1'],
  buildEnabled: true, buildRecipe: 'fixed-adj9-T4',
} as const;

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

export async function openGr3xOfficial(raw: Uint8Array): Promise<{ fw: Firmware; decoded: Uint8Array }> {
  const p = GR3X_160;
  if (raw.length !== p.size || await sha256Hex(raw) !== p.sha256) {
    throw new FirmwareError('unsupported-firmware', 'GR IIIx HDF requires the exact official 1.60 fwdc243b.bin');
  }
  const fw = new Firmware(raw);
  const decoded = fw.decoded;
  const rtos = sectionsOf(decoded).find(s => s.name === 'RTOS');
  if (fw.project !== p.project || decoded.length !== p.decodedSize || await sha256Hex(decoded) !== p.decodedSha256 ||
      !rtos || rtos.offset !== p.rtosOffset || rtos.size !== p.rtosLength ||
      await sha256Hex(decoded.subarray(rtos.offset, rtos.offset + rtos.size)) !== p.rtosSha256) {
    throw new FirmwareError('unexpected-layout', 'GR IIIx container or RTOS does not match the verified baseline');
  }
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const startup = [p.ramSource, p.ramBase, p.ramLength];
  if (startup.some((v, i) => view.getUint32(p.rtosOffset + 0x450 + i * 4, true) !== v)) {
    throw new FirmwareError('unexpected-layout', 'GR IIIx startup data map changed');
  }
  return { fw, decoded };
}

export function requireGr3xPort(feature: string): never {
  throw new FirmwareError('gr3x-port-incomplete', `GR IIIx HDF 1.60: ${feature} is not ported; this branch supports fixed ADJ9, clarity soft focus and nine T6 CUBE film slots`);
}
