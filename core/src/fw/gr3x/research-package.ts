// SPDX-License-Identifier: GPL-2.0-only
/** Package fixed-nine IIIx patches as an offline research artifact or a local
 * hardware-test candidate. Neither mode establishes successful camera startup.
 * Kept separate from Engine's general-purpose builder and SD-card operations. */
import { buildGrown, FRAME_SIZE, sectionsOf, sha256Hex, sum32 } from '../container';
import { countChangedBytes, selfCheckGrown } from '../selfcheck';
import { FirmwareError } from '../types';
import type { Range } from '../types';
import { buildGr3xAdjResearch } from './adj';
import type { Gr3xAdjFeatures } from './adj';
import { GR3X_160, openGr3xOfficial } from './profile';
import { GR3X_CLARITY_OFFSET, gr3xClarityBytes } from './clarity';
import type { Gr3xSoftFocusRequest } from './clarity';
import { buildGr3xImageControls } from './image-control';
import type { Gr3xLookOptions } from './image-control';
import { encodeGr3xLookRecipe } from './look-recipe';
import { encodeGr3xRatioRecipe } from './ratio-recipe';
import { GR3X_T4_MENU, gr3xIsT4Menu } from './geometry';
import { readRes, resRecords } from '../aspect/res';
import { GR3X_RES_BEFORE, GR3X_RES_MAX_FILES, gr3xPicturePath } from './shutdown';
import type { Gr3xMenuRatio } from './geometry';

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], b => parseInt(b, 16));
const roundFrame = (n: number) => Math.ceil(n / FRAME_SIZE) * FRAME_SIZE;

/** ICONBIN's partition and RAM area are 0x1800000 bytes; GR Mod keeps 256 KB of them free. */
export const GR3X_ICONBIN_MAX = 0x1800000 - 0x40000;

export async function buildGr3xResearchContainer(raw: Uint8Array) {
  const result = await buildContainer(raw, 'research');
  return { ...result, report: { ...result.report, flashable: false as const } };
}

/** `ratioMenu` comes from `planGr3xMenu`; the default is the T4 menu. */
export async function buildGr3xTestFirmware(raw: Uint8Array, softFocus: readonly Gr3xSoftFocusRequest[] = [], looks?: Gr3xLookOptions, ratioMenu: readonly Gr3xMenuRatio[] = GR3X_T4_MENU, features: Gr3xAdjFeatures = {}) {
  return buildContainer(raw, 'hardware-test', softFocus, looks, ratioMenu, features);
}

async function buildContainer(raw: Uint8Array, purpose: 'research' | 'hardware-test', softFocus: readonly Gr3xSoftFocusRequest[] = [], looks?: Gr3xLookOptions, ratioMenu: readonly Gr3xMenuRatio[] = GR3X_T4_MENU, features: Gr3xAdjFeatures = {}) {
  // Soft focus is either on the ADJ lever or in the negative clarity rows, not both (the ADJ
  // version takes over the clarity function's row selection).
  if (features.adjSoftFocus && softFocus.length) throw new FirmwareError('bad-clarity', 'ADJ soft focus replaces the clarity-table soft focus');
  const manifest = looks ? await buildGr3xImageControls(raw, looks, ratioMenu, features) : await buildGr3xAdjResearch(raw, ratioMenu, features);
  const menu = manifest.menu, t4 = gr3xIsT4Menu(menu);
  const { fw, decoded, profile } = await openGr3xOfficial(raw);
  const sections = sectionsOf(decoded);
  const rtos = sections.find(s => s.name === 'RTOS')!;
  const icon = sections.find(s => s.name === 'ICONBIN')!;
  if (!(rtos.offset < icon.offset)) throw new FirmwareError('unexpected-layout', 'IIIx section order');
  const addition = unhex(manifest.append.bytes), pixels = unhex(manifest.iconAddition.bytes);
  const revision = features.round10 ? 'T10' : features.round9 ? 'T9' : features.round8 ? 'T8' : features.round7 ? 'T7' : looks ? (looks.displayRevision === 3 ? 'T6' : looks.displayRevision === 1 ? 'T5' : 'T5-L1') : softFocus.length ? 'T4-SF1' : 'T4';
  const lookRecipe = looks ? encodeGr3xLookRecipe(looks) : new Uint8Array();
  const ratioRecipe = t4 && !features.adjSoftFocus && !features.dateImprint && !features.pictures?.length && !features.round7 ? new Uint8Array() : encodeGr3xRatioRecipe(menu, features);
  const recipe = new Uint8Array(lookRecipe.length + ratioRecipe.length);
  recipe.set(lookRecipe); recipe.set(ratioRecipe, lookRecipe.length);
  const record = new TextEncoder().encode(purpose === 'research'
    ? `GR3X-ADJ${menu.length}-RESEARCH-NOT-FOR-CAMERA\0` : `${profile.tag}-ADJ${menu.length}-${revision}-HARDWARE-UNTESTED\0`);
  const rtosGrowth = roundFrame(addition.length + recipe.length + record.length + 4);
  const iconGrowth = roundFrame(pixels.length);
  const rtosEnd = rtos.offset + rtos.size, iconEnd = icon.offset + icon.size;
  // The camera writes sections one after the other and checks a section against its partition
  // only when it gets to it (0x5362c88c): ICONBIN (partition 4, 0x1800000 bytes, also the size of
  // its RAM area at 0x51600000) comes after BOOT, RTOS and LINUX, so an oversized ICONBIN would be
  // refused with the new RTOS already written and the old partition table. Refused here instead,
  // with 256 KB to spare; RTOS must end below its initialised data at 0x55000000 (its partition is
  // 0x4000000).
  if (icon.size + iconGrowth > GR3X_ICONBIN_MAX) throw new FirmwareError('no-space', 'IIIx icons exceed the ICONBIN partition (fewer power-off pictures or films)');
  if (rtos.size + rtosGrowth > 0x4000000 || 0x53000000 + rtos.size + rtosGrowth > 0x55000000) throw new FirmwareError('no-space', 'IIIx RTOS exceeds its partition');
  // Power-off pictures: RES records (two frames each) after the A: files, before the first B: file (shutdown.ts).
  const pictures = features.pictures ?? [];
  let resAt = 0, resCountOffset = 0, resCount = 0, resBlock: Uint8Array = new Uint8Array();
  if (pictures.length) {
    const dir = readRes(decoded);
    const at = dir.files.findIndex(f => f.path === GR3X_RES_BEFORE);
    // Official: 22 A: files, then 13 B: files; the pictures go between them.
    if (dir.files.length !== 35 || at !== 22 || dir.files.slice(0, at).some(f => !f.path.startsWith('A:\\')) || dir.files.slice(at).some(f => !f.path.startsWith('B:\\')) ||
      dir.countOffset < iconEnd || dir.end !== decoded.length - 4) throw new FirmwareError('unexpected-layout', 'IIIx RES section is not the official one');
    if (dir.files.length + pictures.length > GR3X_RES_MAX_FILES) throw new FirmwareError('too-many-pictures', 'IIIx RES file count');
    const last = dir.files[at];
    const files = pictures.map((pic, k) => ({ path: gr3xPicturePath(k), data: pic.jpeg }));
    if (dir.files.some(f => files.some(x => x.path === f.path))) throw new FirmwareError('unexpected-layout', 'IIIx RES already holds power-off pictures');
    resBlock = resRecords(files);
    if (resBlock.length % FRAME_SIZE) throw new FirmwareError('internal', 'IIIx power-off pictures are not whole frames');
    resAt = last.offset; resCountOffset = dir.countOffset; resCount = dir.files.length + files.length;
  }
  const resGrowth = resBlock.length;
  const out = new Uint8Array(decoded.length + rtosGrowth + iconGrowth + resGrowth);
  out.set(decoded.subarray(0, rtosEnd));
  out.set(addition, rtosEnd);
  out.set(recipe, rtosEnd + addition.length);
  out.set(decoded.subarray(rtosEnd, iconEnd), rtosEnd + rtosGrowth);
  out.set(pixels, iconEnd + rtosGrowth);
  const shifted = rtosGrowth + iconGrowth;
  if (resGrowth) {
    out.set(decoded.subarray(iconEnd, resAt), iconEnd + shifted);
    out.set(resBlock, resAt + shifted);
    out.set(decoded.subarray(resAt), resAt + shifted + resGrowth);
  } else out.set(decoded.subarray(iconEnd), iconEnd + shifted);
  const view = new DataView(out.buffer);
  if (resGrowth) view.setUint32(resCountOffset + shifted, resCount, true);
  view.setUint32(rtos.offset - 4, rtos.size + rtosGrowth, true);
  const iconOffset = icon.offset + rtosGrowth;
  view.setUint32(iconOffset - 4, icon.size + iconGrowth, true);
  const ranges: Range[] = [];
  let changedBytes = rtosGrowth + iconGrowth + resGrowth;
  for (const site of manifest.sites) {
    const offset = rtos.offset + site.address - GR3X_160.rtosBase;
    const old = unhex(site.expected), next = unhex(site.replacement);
    if (old.length !== 4 || next.length !== 4 || old.some((b, i) => decoded[offset + i] !== b)) {
      throw new FirmwareError('unexpected-instruction', 'IIIx research package instruction guard');
    }
    out.set(next, offset);
    changedBytes += countChangedBytes(old, next);
    ranges.push({ what: site.reason, offset, length: 4 });
  }
  if (softFocus.length) {
    const next = gr3xClarityBytes(decoded, softFocus);
    const offset = GR3X_CLARITY_OFFSET;
    changedBytes += countChangedBytes(decoded.subarray(offset, offset + next.length), next);
    out.set(next, offset);
    ranges.push({ what: 'IIIx negative clarity soft-focus gains', offset, length: next.length });
  }
  out.set(record, rtosEnd + rtosGrowth - record.length - 4);
  view.setUint32(rtosEnd + rtosGrowth - 4, (-sum32(out)) >>> 0, true);
  ranges.push(
    { what: 'IIIx RTOS section length', offset: rtos.offset - 4, length: 4 },
    { what: 'IIIx appended code, catalogs and checksum', offset: rtosEnd, length: rtosGrowth },
    { what: 'IIIx ICONBIN section length', offset: iconOffset - 4, length: 4 },
    { what: 'IIIx appended ratio icon pixels', offset: iconEnd + rtosGrowth, length: iconGrowth },
    ...(resGrowth ? [{ what: 'IIIx RES file count', offset: resCountOffset + shifted, length: 4 },
      { what: 'IIIx power-off pictures (RES files)', offset: resAt + shifted, length: resGrowth }] : []),
  );
  changedBytes += countChangedBytes(decoded.subarray(rtos.offset - 4, rtos.offset), out.subarray(rtos.offset - 4, rtos.offset));
  changedBytes += countChangedBytes(decoded.subarray(icon.offset - 4, icon.offset), out.subarray(iconOffset - 4, iconOffset));
  if (resGrowth) changedBytes += countChangedBytes(decoded.subarray(resCountOffset, resCountOffset + 4), out.subarray(resCountOffset + shifted, resCountOffset + shifted + 4));
  const insertions = [{ at: rtosEnd, length: rtosGrowth }, { at: iconEnd, length: iconGrowth }, ...(resGrowth ? [{ at: resAt, length: resGrowth }] : [])];
  const built = buildGrown(fw, out, insertions);
  const checks = selfCheckGrown(raw, built.out, ranges, out);
  if (Object.values(checks).some(v => !v)) {
    throw new FirmwareError('self-check-failed', 'IIIx research container check failed: ' +
      Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', '));
  }
  return {
    bytes: built.out, manifest, decodedSha256: await sha256Hex(out), changedFrames: built.reencoded, changedBytes,
    report: {
      schema: 1, kind: purpose === 'research' ? 'gr3x-adj-research-container' : 'gr3x-adj9-test-firmware',
      profile: profile.id, camera: profile.camera, fullFeatures: profile.fullFeatures, purpose,
      revision: purpose === 'research' ? 'research' : revision,
      softFocus: softFocus.map(r => ({ ...r })), adjSoftFocus: features.adjSoftFocus === true,
      imageControls: looks && 'addedLooks' in manifest ? manifest.addedLooks.map(s => ({
        id: s.id, name: s.name, source: s.source, nativeBase: s.nativeBase,
      })) : [],
      filename: purpose === 'research' ? `${profile.tag}-ADJ${menu.length}.NOT-FOR-CAMERA.bin` : profile.filename,
      inputSha256: profile.sha256, outputSha256: await sha256Hex(built.out),
      outputBytes: built.out.length, decodedBytes: out.length,
      rtosGrowth, iconGrowth, resGrowth, pictures: pictures.map(pic => pic.name), reencodedFrames: built.reencoded.length,
      firmwareGenerated: true, hardwareTested: false, cameraUpdateCandidate: purpose === 'hardware-test',
      rearDialPatched: false, versionRaised: false,
      rawFullFrame: true, rawDefaultCrop: [6000, 4000], faceDetectionModeInitialized: true,
      wideDevelopmentApertureUsesNative3x2Width: true,
      wideLiveViewHeightAlignment: 4,
      predecessorHardwareEvidence: looks ? (revision === 'T6'
        ? 'The owner confirmed T5-L1 icons display correctly. Seven additional JPG/DNG pairs R0001535-R0001541 decoded; all RAW default crops remain 6000x4000 with colour retained, while JPEG/embedded previews follow 3:2, 16:9, 65:24, 17:6 and 3:4. T6 nine-slot expansion and film colours still need camera testing.'
        : revision === 'T5-L1'
        ? 'T5 was installed and the owner confirmed Standard, two demos and six replicas in order. Nine JPG/DNG pairs decode; all RAW default crops are 6000x4000 and independent sensor development retains colour. All six replica JPGs are neutral grey. The owner reports missing logos in both the control list and shooting view. T5-L1 display changes still require a hardware retest.'
        : 'The owner reports T4 resolved wide post-capture flicker. 99 outdoor JPG/DNG pairs retained full 6000x4000 RAW and ratio-specific JPEG/previews. SF1 was subsequently tested at Clarity 0/-1/-2/-3 with HDF off. T5 new looks have not been tested on camera.')
        : 'T3 installed on GR IIIx HDF: eight new DNGs preserve the full 6000x4000 default crop, JPEG/embedded previews follow the selected ratio. Wide post-capture green/purple corruption persists with instant review disabled. T4 corrects reproduced odd YUV420 origins in native recipe and resize descriptors; the relationship to physical flicker requires a camera retest.',
      ratios: manifest.ratios, ratioMenu: menu.map(r => ({ ...r })), customRatios: !t4, checks, ranges,
      blockers: manifest.blockers,
      scope: looks ? revision + ': T4 geometry/full RAW, optional SF1, ' + (revision === 'T6' ? 'nine independent CUBE films without legacy demos/replicas' : 'two CUBE slots and six optional monochrome replicas') + '. Hardware test candidate; display, complete boot/capture/persistence require camera testing.' : 'Fixed nine-ratio ADJ port. Native function and format checks are reproducible; physical updating, boot, real menu rendering, persistent storage and complete image capture require camera testing.',
    },
  };
}
