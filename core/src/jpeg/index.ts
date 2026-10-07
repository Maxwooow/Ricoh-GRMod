// Baseline JPEG tools for the camera's power-off screen: an encoder that hits
// an exact byte length, a structure inspector / checker and a plain decoder.
// Pure TypeScript, no platform APIs.

export { JpegError } from './errors';
export type { JpegErrorCode } from './errors';

export { encodeJpeg, minimumJpegSize, HEADER_BYTES, OVERHEAD_BYTES } from './encoder';
export type { Sampling } from './encoder';

export { encodeExactJpeg, DEFAULT_MAX_ITERATIONS } from './exact';
export type { ExactJpegOptions, ExactJpegResult } from './exact';

export { inspectJpeg, markerName, MARKER } from './inspect';
export type { JpegInfo, JpegComponent, JpegSegment } from './inspect';

export { checkShutdownJpeg } from './check';
export type { ShutdownJpegExpectation } from './check';

export { decodeBaselineJpeg } from './decoder';

export { qualityTables, naturalToZigzag, zigzagToNatural, ZIGZAG, STD_LUMA_QTABLE, STD_CHROMA_QTABLE } from './tables';
