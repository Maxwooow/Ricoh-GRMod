// SPDX-License-Identifier: GPL-2.0-only
/** Package fixed-nine IIIx patches as an offline research artifact or a local
 * hardware-test candidate. Neither mode establishes successful camera startup.
 * Kept separate from Engine's general-purpose builder and SD-card operations. */
import { buildGrown, FRAME_SIZE, sectionsOf, sha256Hex, sum32 } from '../container';
import { countChangedBytes, selfCheckGrown } from '../selfcheck';
import { FirmwareError } from '../types';
import type { Range } from '../types';
import { buildGr3xAdjResearch } from './adj';
import { GR3X_160, openGr3xOfficial } from './profile';
import { GR3X_CLARITY_OFFSET, gr3xClarityBytes } from './clarity';
import type { Gr3xSoftFocusRequest } from './clarity';
import { buildGr3xImageControls } from './image-control';
import type { Gr3xLookOptions } from './image-control';
import { encodeGr3xLookRecipe } from './look-recipe';

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], b => parseInt(b, 16));
const roundFrame = (n: number) => Math.ceil(n / FRAME_SIZE) * FRAME_SIZE;

export async function buildGr3xResearchContainer(raw: Uint8Array) {
  const result = await buildContainer(raw, 'research');
  return { ...result, report: { ...result.report, flashable: false as const } };
}

export async function buildGr3xTestFirmware(raw: Uint8Array, softFocus: readonly Gr3xSoftFocusRequest[] = [], looks?: Gr3xLookOptions) {
  return buildContainer(raw, 'hardware-test', softFocus, looks);
}

async function buildContainer(raw: Uint8Array, purpose: 'research' | 'hardware-test', softFocus: readonly Gr3xSoftFocusRequest[] = [], looks?: Gr3xLookOptions) {
  const manifest = looks ? await buildGr3xImageControls(raw, looks) : await buildGr3xAdjResearch(raw);
  const { fw, decoded } = await openGr3xOfficial(raw);
  const sections = sectionsOf(decoded);
  const rtos = sections.find(s => s.name === 'RTOS')!;
  const icon = sections.find(s => s.name === 'ICONBIN')!;
  if (!(rtos.offset < icon.offset)) throw new FirmwareError('unexpected-layout', 'IIIx section order');
  const addition = unhex(manifest.append.bytes), pixels = unhex(manifest.iconAddition.bytes);
  const revision = looks ? (looks.displayRevision === 3 ? 'T6' : looks.displayRevision === 1 ? 'T5' : 'T5-L1') : softFocus.length ? 'T4-SF1' : 'T4';
  const recipe = looks ? encodeGr3xLookRecipe(looks) : new Uint8Array();
  const record = new TextEncoder().encode(purpose === 'research'
    ? 'GR3X-ADJ9-RESEARCH-NOT-FOR-CAMERA\0' : `GR3X-HDF-160-ADJ9-${revision}-HARDWARE-UNTESTED\0`);
  const rtosGrowth = roundFrame(addition.length + recipe.length + record.length + 4);
  const iconGrowth = roundFrame(pixels.length);
  const rtosEnd = rtos.offset + rtos.size, iconEnd = icon.offset + icon.size;
  const out = new Uint8Array(decoded.length + rtosGrowth + iconGrowth);
  out.set(decoded.subarray(0, rtosEnd));
  out.set(addition, rtosEnd);
  out.set(recipe, rtosEnd + addition.length);
  out.set(decoded.subarray(rtosEnd, iconEnd), rtosEnd + rtosGrowth);
  out.set(pixels, iconEnd + rtosGrowth);
  out.set(decoded.subarray(iconEnd), iconEnd + rtosGrowth + iconGrowth);
  const view = new DataView(out.buffer);
  view.setUint32(rtos.offset - 4, rtos.size + rtosGrowth, true);
  const iconOffset = icon.offset + rtosGrowth;
  view.setUint32(iconOffset - 4, icon.size + iconGrowth, true);
  const ranges: Range[] = [];
  let changedBytes = rtosGrowth + iconGrowth;
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
  );
  changedBytes += countChangedBytes(decoded.subarray(rtos.offset - 4, rtos.offset), out.subarray(rtos.offset - 4, rtos.offset));
  changedBytes += countChangedBytes(decoded.subarray(icon.offset - 4, icon.offset), out.subarray(iconOffset - 4, iconOffset));
  const insertions = [{ at: rtosEnd, length: rtosGrowth }, { at: iconEnd, length: iconGrowth }];
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
      profile: GR3X_160.id, purpose,
      revision: purpose === 'research' ? 'research' : revision,
      softFocus: softFocus.map(r => ({ ...r })),
      imageControls: looks && 'addedLooks' in manifest ? manifest.addedLooks.map(s => ({
        id: s.id, name: s.name, source: s.source, nativeBase: s.nativeBase,
      })) : [],
      filename: purpose === 'research' ? 'GR3x-1.60-ADJ9.NOT-FOR-CAMERA.bin' : GR3X_160.filename,
      inputSha256: GR3X_160.sha256, outputSha256: await sha256Hex(built.out),
      outputBytes: built.out.length, decodedBytes: out.length,
      rtosGrowth, iconGrowth, reencodedFrames: built.reencoded.length,
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
      ratios: manifest.ratios, checks, ranges,
      blockers: manifest.blockers,
      scope: looks ? revision + ': T4 geometry/full RAW, optional SF1, ' + (revision === 'T6' ? 'nine independent CUBE films without legacy demos/replicas' : 'two CUBE slots and six optional monochrome replicas') + '. Hardware test candidate; display, complete boot/capture/persistence require camera testing.' : 'Fixed nine-ratio ADJ port. Native function and format checks are reproducible; physical updating, boot, real menu rendering, persistent storage and complete image capture require camera testing.',
    },
  };
}
