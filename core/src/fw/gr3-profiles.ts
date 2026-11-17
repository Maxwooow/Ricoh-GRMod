// SPDX-License-Identifier: GPL-2.0-only
/**
 * The official GR III / IIIx releases GR Mod builds on: what identifies each file and where its parts are.
 * Plain data, shared by every release of the program in fw/gr3x (which is written for 1.60 / 2.10 and takes
 * the others' addresses from their tables, see release.ts): the values here are each release's own and are
 * never moved through an address table.
 *
 * GR IIIx and GR III of one release are the same build of one program: every function and data address is
 * identical, and the two images differ only in ~30 identity bytes (camera name, project and product number,
 * version, build time, the RTC epoch year). GR IIIx's file is shared by the standard, Urban and HDF cameras;
 * GR III's by the standard, Street, Diary and HDF cameras. A firmware file cannot prove which physical
 * variant is connected.
 *
 *   1.60 / 2.10  the release the program is written for.
 *   1.70 / 2.20  Ricoh's 30th-anniversary release: the power-off picture request (variants 5 and 6, the 20th
 *                and 30th anniversary pictures on A:, JPEG table indices 13 and 14), the factory keyword parser,
 *                GR Mod's RAM words (the start-up fill ends 0x740 lower), the RES layout (24 A: files).
 *   1.71 / 2.21  Reset Settings by item: one more submenu record and six more controller ids, seven more
 *                texts, the text readers' bound as a compare.
 */
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

/** GR III 2.10 (fwdc239b.bin). Layout fields must equal GR3X_160's: openGr3xOfficial and the tests assert it,
 * and every address of the program relies on it. */
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

export const GR3X_170 = {
  id: 'gr3x-hdf-1.70', model: 'GR3X_HDF', standardModel: 'GR3X', camera: 'GR IIIx', tag: 'GR3X-HDF-170',
  version: '1.70', internalVersion: '1.70.20.18', versionWord: 0x01461412,
  filename: 'fwdc243b.bin', size: 30472528, decodedSize: 59798532,
  sha256: 'aa8e3ae1349d94e83be381c20530e41d5e57b75c27ef24ba81c7b017d6c11592',
  decodedSha256: '1129b9289b3cc68ab6f407a87d60db750483cc5ae41a6609596f6fe676b14521',
  rtosSha256: '3d97f0f541c6711b56dcd66ffc081be97af303708cc1874b29f9bd8ee7a8d0c5',
  project: 609, product: 78490, rtosOffset: 0x10870, rtosLength: 17520384, rtosBase: 0x53000000,
  ramSource: 0x5407b640, ramBase: 0x55000000, ramLength: 0x3a0c0,
  factoryRatios: ['3:2', '1:1'],
  buildEnabled: true, buildRecipe: 'fixed-adj9-T4', fullFeatures: true,
} as const satisfies Gr3Profile;

/** GR III 2.20 (fwdc239b.bin). Layout fields must equal GR3X_170's: openGr3xOfficial and the tests assert it,
 * and every address of the program relies on it. */
export const GR3_220 = {
  ...GR3X_170,
  id: 'gr3-hdf-2.20', model: 'GR3_HDF', standardModel: 'GR3', camera: 'GR III', tag: 'GR3-HDF-220',
  version: '2.20', internalVersion: '2.20.20.28', versionWord: 0x0214141c,
  filename: 'fwdc239b.bin', size: 30472516,
  sha256: '5c53760b3b564c87239dbf7f5c94d0f6fd91accd156ec4ba672ebfd6b861793e',
  decodedSha256: '5b475fcc434dec0f12e7956b02b5b38959d599b7a4ff90486263c46816a21b6d',
  rtosSha256: 'fb13f9b4e49abec5f036d3f9fc5e4d21ba2a4e65522efb849ac52a7151c87da9',
  project: 588, product: 78350, fullFeatures: true,
} as const satisfies Gr3Profile;

export const GR3X_171 = {
  id: 'gr3x-hdf-1.71', model: 'GR3X_HDF', standardModel: 'GR3X', camera: 'GR IIIx', tag: 'GR3X-HDF-171',
  version: '1.71', internalVersion: '1.71.20.19', versionWord: 0x01471413,
  filename: 'fwdc243b.bin', size: 30476980, decodedSize: 59836420,
  sha256: '7d7e9d8173bcc8bcc8bab1df185ae66671ff2a33c870067a6f4c029c628bedc9',
  decodedSha256: '3d91125318fb3c1dd19012292dd99b5053139302b05f1d9d1bfe22d620e046ac',
  rtosSha256: '2ba5e74c6b1564c5787c068d46bdf90b7571b497d2d543309e7a930b98e5b75c',
  project: 609, product: 78490, rtosOffset: 0x10870, rtosLength: 17557824, rtosBase: 0x53000000,
  ramSource: 0x54084640, ramBase: 0x55000000, ramLength: 0x3a300,
  factoryRatios: ['3:2', '1:1'],
  buildEnabled: true, buildRecipe: 'fixed-adj9-T4', fullFeatures: true,
} as const satisfies Gr3Profile;

/** GR III 2.21 (fwdc239b.bin). Layout fields must equal GR3X_171's: openGr3xOfficial and the tests assert it,
 * and every address of the program relies on it. */
export const GR3_221 = {
  ...GR3X_171,
  id: 'gr3-hdf-2.21', model: 'GR3_HDF', standardModel: 'GR3', camera: 'GR III', tag: 'GR3-HDF-221',
  version: '2.21', internalVersion: '2.21.20.29', versionWord: 0x0215141d,
  filename: 'fwdc239b.bin', size: 30476976,
  sha256: '7522c36b74294fa854391217f151ef731a4ebbd6ef4449dcf05684828aea4bd9',
  decodedSha256: 'aed094bf84870155bbc25e3151e042f50f37e6c1deec26532c98f39570c2ee5f',
  rtosSha256: '9117ae44764d6c542c2b8d1b138a6132261125873c7d77f571277767279463b7',
  project: 588, product: 78350, fullFeatures: true,
} as const satisfies Gr3Profile;
