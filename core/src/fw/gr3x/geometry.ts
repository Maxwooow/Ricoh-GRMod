// SPDX-License-Identifier: GPL-2.0-only
/** Planning only. The photo is derived from the requested ratio, independently of the
 * rounded LCD rectangle. Encoder alignment, AF and playback need hardware validation. */
import { FirmwareError } from '../types';
import { alignedCrop, parseRatio, ratioText } from '../aspect/geometry';
import { GR3X_160 } from './profile';

export const GFX_RATIOS = ['4:3', '3:2', '16:9', '65:24', '17:6', '3:4', '1:1', '7:6', '5:4'] as const;
/** Measured by executing the original 1.60 dimension function, no digital crop, L/M/S/XS. */
export const GR3X_BASE_SIZES: readonly (readonly [number, number])[] = [[6000, 4000], [4800, 3200], [3360, 2240], [1920, 1280]];

export function planGr3xRatio(text: string) {
  const requested = parseRatio(text);
  if (GR3X_160.factoryRatios.some(r => requested.eq(parseRatio(r)))) {
    throw new FirmwareError('ratio-factory', 'the camera already has this ratio');
  }
  const screen = alignedCrop(720, 480, requested);
  const photos = GR3X_BASE_SIZES.map(([w, h]) => alignedCrop(w, h, requested));
  if (!screen || photos.some(p => !p)) throw new FirmwareError('ratio-too-extreme', 'ratio leaves no usable rectangle');
  const sizes = photos.map(p => [p!.width, p!.height] as [number, number]);
  const actual = ratioText(sizes[0][0], sizes[0][1]);
  return {
    requested: text, actual, screenActual: ratioText(screen.width, screen.height), screen, sizes,
    errorPercent: (sizes[0][0] / sizes[0][1] / requested.toNumber() - 1) * 100,
    // This is an allocation requirement to investigate, not a patch to the stored image.
    playbackRows: sizes.map(([, h]) => Math.ceil(h / 8) * 8),
    status: 'planning-only' as const,
  };
}
