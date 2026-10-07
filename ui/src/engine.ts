import type { CameraModel, FirmwareBuild, FirmwareInfo, FirmwareSummary, PresetResult, RatioPreview, RatioSpec, ShutdownImage, SlotRequest } from '@grmod/core';

export class EngineError extends Error {
  code: string; details?: Record<string, number>;
  constructor(code: string, message: string, details?: Record<string, number>) { super(message); this.code = code; this.details = details; }
}

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (f: number) => void }>();
worker.onmessage = (ev: MessageEvent) => {
  const m = ev.data as { id: number; ok?: boolean; result?: unknown; error?: { code: string; message: string; details?: Record<string, number> }; progress?: number };
  const p = pending.get(m.id);
  if (!p) return;
  if (m.progress !== undefined) { p.onProgress?.(m.progress); return; }
  pending.delete(m.id);
  if (m.ok) p.resolve(m.result); else p.reject(new EngineError(m.error?.code || 'error', m.error?.message || 'error', m.error?.details));
};
function call<T>(msg: Record<string, unknown>, transfer: Transferable[] = [], onProgress?: (f: number) => void): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

export const engine = {
  open: (raw: Uint8Array) => call<FirmwareInfo>({ type: 'open', raw: raw.slice().buffer }),
  convert: (kind: 'xmp' | 'cube', text: string) => call<PresetResult>({ type: 'convert', kind, text }),
  build: (requests: SlotRequest[], ratios: RatioSpec[] = []) => call<FirmwareBuild>({ type: 'build', requests, ratios }),
  /** What a ratio would become in the camera, given the ratios already in the list. */
  ratio: (ratio: string, others: string[]) => call<RatioPreview>({ type: 'ratio', ratio, others }),
  encode: (rgb: Uint8Array, model: CameraModel) => { const copy = rgb.slice(); return call<ShutdownImage>({ type: 'encode', rgb: copy.buffer, model }, [copy.buffer]); },
  script: (model: CameraModel, count: number) => call<string>({ type: 'script', model, count }),
  /** What a firmware file is; the buffer is handed over to the worker. */
  inspect: (raw: Uint8Array) => call<FirmwareSummary>({ type: 'inspect', raw: raw.buffer }, [raw.buffer as ArrayBuffer]),
  heartbeat: (token: string) => call<boolean>({ type: 'heartbeat', token }),
};
