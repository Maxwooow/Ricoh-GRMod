// SPDX-License-Identifier: GPL-2.0-only
/** Lossless CUBE intake plus a separate IIIx matrix/RGB-curve fit. */
import { applyCube, parseCube } from './cube';
import { ColorError } from './math';
import { sha256Hex } from '../fw/container';
import { syntheticSamples } from './convert';
import type { Conversion, ConvertOptions } from './convert';
import { fitSlot } from './fit';
import { deltaELab, lab, mean, percentile } from './math';
import { GR3X_CAMERA } from './gr3x-camera';

export interface Gr3xCubeImport {
  schema: 1;
  kind: 'gr3x-cube-source';
  title: string;
  sourceText: string;
  sourceSha256: string;
  size1D: number;
  size3D: number;
  inputEncoding: 'srgb-display';
  firmwareEncoding: 'matrix-rgb-curve-fit';
  cameraRenderingVerified: false;
}

/** CUBE has no dependable color-space tag. Log/scene-linear input must be converted
 * to an sRGB-display LUT by its author before choosing this explicit encoding. */
export async function importGr3xCube(text: string, inputEncoding: 'srgb-display'): Promise<Gr3xCubeImport> {
  if (inputEncoding !== 'srgb-display') throw new ColorError('bad-input', 'an sRGB-display CUBE is required');
  if (typeof text !== 'string' || text.length > 32 * 1024 * 1024)
    throw new ColorError('bad-input', 'CUBE source is missing or exceeds 32 MiB of text');
  const cube = parseCube(text);
  return {
    schema: 1, kind: 'gr3x-cube-source', title: cube.title, sourceText: text,
    sourceSha256: await sha256Hex(new TextEncoder().encode(text)),
    size1D: cube.size1D, size3D: cube.size3D, inputEncoding,
    firmwareEncoding: 'matrix-rgb-curve-fit', cameraRenderingVerified: false,
  };
}

/** Exact software LUT evaluation, distinct from the fitted camera preview. */
export async function previewGr3xCube(source: Gr3xCubeImport, rgb: Float64Array): Promise<Float64Array> {
  if (!source || source.schema !== 1 || source.kind !== 'gr3x-cube-source' || source.inputEncoding !== 'srgb-display' ||
      source.firmwareEncoding !== 'matrix-rgb-curve-fit' || source.cameraRenderingVerified !== false)
    throw new ColorError('bad-input', 'not an offline IIIx CUBE source');
  if (!(rgb instanceof Float64Array) || rgb.length % 3 || Array.from(rgb).some(v => !Number.isFinite(v)))
    throw new ColorError('bad-input', 'preview input must contain finite RGB triples');
  const checked = await importGr3xCube(source.sourceText, source.inputEncoding);
  if (checked.sourceSha256 !== source.sourceSha256 || checked.size1D !== source.size1D || checked.size3D !== source.size3D)
    throw new ColorError('bad-input', 'CUBE source or its metadata was changed');
  return applyCube(parseCube(source.sourceText), rgb);
}

/** Fit display-referred sRGB CUBE data to IIIx's actual matrix/curve format.
 * The reference curve comes from IIIx native code; no GR IV calibration is used.
 * Independent validation samples estimate approximation error, not camera accuracy.
 */
export function convertGr3xCube(text: string, options: ConvertOptions = {}): Conversion {
  if (text.length > 32 * 1024 * 1024) throw new ColorError('bad-input', 'IIIx CUBE exceeds 32 MiB');
  const cube = parseCube(text);
  const P = syntheticSamples(2200, 160, 4);
  options.onProgress?.(0.05);
  const fit = fitSlot(P, applyCube(cube, P), {
    camera: GR3X_CAMERA, maxIterations: 250,
    onProgress: f => options.onProgress?.(0.05 + f * 0.9),
  });
  const validation = syntheticSamples(1100, 161, 1);
  const errors = deltaELab(lab(GR3X_CAMERA.slotApply(fit, validation)), lab(applyCube(cube, validation)));
  const meanDE = mean(errors), p95DE = percentile(errors, 95);
  const warnings = [
    'IIIx: sRGB display LUT only. Matrix/RGB-curve approximation; preview is a software reference, not measured camera color.',
    'Keep a full-frame RAW. In-camera RAW development falls back to the original base Image Control.',
  ];
  if (p95DE > 6) warnings.push('Large color differences in parts of this LUT; compare the preview before exporting.');
  options.onProgress?.(1);
  return { kind: 'cube', title: cube.title, params: { M1: fit.M1, ck: fit.ck },
    meanDE, p95DE, warnings, unsupported: [] };
}
