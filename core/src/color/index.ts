// Colour pipeline: film-look preset (.xmp Look profile or .cube LUT) -> GR IV Image Control slot.
export { ColorError, lab, deltaE, deltaELab, srgbToLin, linToSrgb } from './math';
export type { ColorErrorCode } from './math';
export { S, Sinv, slotApply, quantizeSlot, KN, KNOTS } from './camera';
export type { SlotParams, QuantizedSlot } from './camera';
export { parseXmp } from './xmp';
export type { XmpLook, RgbTable, LookTable, ToneCurves, CurvePoints } from './xmp';
export { FullLook, Tone } from './look';
export { parseCube, applyCube } from './cube';
export type { Cube } from './cube';
export { fitSlot } from './fit';
export type { FitOptions, FitResult } from './fit';
export { convertXmp, convertCube, previewSlot } from './convert';
export type { Conversion, ConvertOptions } from './convert';
export { BASE_CURVE, CAL_CAM, CAL_ADOBE, CAL_COUNT, TONE_PARAMS } from './data';
export { clarityLevels, simulateClarity } from './clarity';
