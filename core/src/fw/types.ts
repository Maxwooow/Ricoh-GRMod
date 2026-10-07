/** One planned, equal-length edit of the decoded payload. `offset` is a decoded-payload offset. */
export interface Range {
  what: string;
  offset: number;
  length: number;
}

/**
 * Error thrown by everything in `fw/`. `code` is short and machine readable;
 * `checks` is attached when a self-check failed.
 */
export class FirmwareError extends Error {
  readonly code: string;
  checks?: Record<string, boolean>;

  constructor(code: string, message?: string, checks?: Record<string, boolean>) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'FirmwareError';
    this.code = code;
    if (checks) this.checks = checks;
  }
}
