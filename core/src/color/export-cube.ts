// A fitted slot as a standard 3D .cube LUT, so the camera's look can be previewed in Lightroom,
// Resolve or Photoshop.
import { GR3X_CAMERA } from './gr3x-camera';
import { slotApply } from './camera';
import type { SlotParams } from './camera';
import { ColorError } from './math';

/**
 * @decision DEC-QOL-EXPORTCUBE-001
 * @title The exported .cube is the slot model's rendering of a Standard picture, in sRGB both ways
 * @status accepted
 * @rationale What it represents. The fitted slot is a function from colours the camera renders in
 *   its Standard Image Control (sRGB-encoded, 0..1) to the colours the slot renders instead (sRGB-
 *   encoded, 0..1): the same function the app's swatches and photo preview apply. The LUT samples
 *   that function on a size^3 lattice (33 by default), so applying the .cube to a Standard-looking
 *   picture gives the slot's look; applying it to a different starting point (a flat log picture, a
 *   linear raw render, a Display-P3 picture) does not, because the input is not what the model was
 *   fitted on. DOMAIN_MIN/MAX are 0 and 1, red varies fastest (the .cube convention, as parseCube
 *   reads it), values print with 6 decimals, TITLE is the slot name.
 *   The renderer is `slotApply` of the camera model of the family (GR IV's base tone curve, or
 *   GR III / IIIx's reference curve), including a post-curve matrix and, for a GR IV added slot
 *   fitted with them, hue sectors. The photo preview (preview.ts applySlot) ignores hue sectors, so
 *   for such a slot the LUT is closer to the camera than the preview is.
 *   Invariant. Identity slot parameters (M1 = I, curves = the knot grid) give an identity LUT up to
 *   the base curve's own round trip S(Sinv(d)), which is exact below the curve's last sample and
 *   clips the top 1/256 of the linear range (a few 1/1000 of white), so the LUT is near-identity,
 *   not bit-exact. Matrix rows sum to 1, so a slot with equal curves keeps grey grey; a toned
 *   slot may tint it, as the camera does.
 *   Limits. Only the colour/tone stage is in the file. Halation (a glow added around highlights),
 *   grain, vignetting, sharpening and clarity are spatial or noise effects a LUT cannot hold and
 *   are not included. Out-of-range results are clipped to 0..1 as the camera clips them. The file
 *   is a preview aid, not a calibrated profile: it is only as exact as the fit (the delta E the
 *   app shows).
 */
export interface ExportCubeOptions {
  /** TITLE line: the slot's name (quotes and line breaks are dropped). */
  title?: string;
  /** Edge length of the lattice, 2..65 (33 by default, the common size for a camera look). */
  size?: number;
  /** Which camera's tone model renders it: GR IV (default) or GR III / IIIx. */
  camera?: 'gr4' | 'gr3x';
}

export const EXPORT_CUBE_SIZE = 33;

/** The text of a .cube file holding the slot's look (see DEC-QOL-EXPORTCUBE-001). Throws ColorError 'bad-input' for a bad size or bad slot parameters. */
export function exportSlotCube(params: SlotParams, opts: ExportCubeOptions = {}): string {
  const n = opts.size ?? EXPORT_CUBE_SIZE;
  if (!Number.isInteger(n) || n < 2 || n > 65) throw new ColorError('bad-input', 'cube size must be an integer from 2 to 65');
  const apply = opts.camera === 'gr3x' ? GR3X_CAMERA.slotApply : slotApply;
  const grid = new Float64Array(n * n * n * 3);
  let p = 0;
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) { grid[p++] = r / (n - 1); grid[p++] = g / (n - 1); grid[p++] = b / (n - 1); }
  const out = apply(params, grid);
  const title = (opts.title ?? '').replace(/["\r\n\s]+/g, ' ').trim();
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${n}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  for (let i = 0; i < out.length; i += 3) lines.push(`${out[i].toFixed(6)} ${out[i + 1].toFixed(6)} ${out[i + 2].toFixed(6)}`);
  return lines.join('\n') + '\n';
}
