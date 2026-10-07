export type JpegErrorCode =
  | 'unreachable-size' // the requested byte length cannot be reached for this image
  | 'bad-input' // arguments are inconsistent (sizes, table values, ...)
  | 'not-jpeg' // the data is not a parseable JPEG file
  | 'unsupported' // a valid JPEG that the baseline decoder does not handle
  | 'corrupt'; // the entropy-coded data does not decode

export class JpegError extends Error {
  readonly code: JpegErrorCode;
  /** Optional numbers that explain the failure (e.g. `minBytes`, `maxBytes`, `byteLength`). */
  readonly details: Readonly<Record<string, number>>;

  constructor(code: JpegErrorCode, message?: string, details: Record<string, number> = {}) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'JpegError';
    this.code = code;
    this.details = details;
  }
}
