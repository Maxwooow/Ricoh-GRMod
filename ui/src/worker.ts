/// <reference lib="webworker" />
import { Engine } from '@grmod/core';
import type { BuildOptions, CameraModel, RatioSpec, SlotRequest, SoftFocusRequest } from '@grmod/core';

let engine: Engine | null = null;
type Req =
  | { id: number; type: 'open'; raw: ArrayBuffer }
  | { id: number; type: 'convert'; kind: 'xmp' | 'cube'; text: string }
  | { id: number; type: 'build'; requests: SlotRequest[]; ratios?: RatioSpec[]; softFocus?: SoftFocusRequest[]; options?: BuildOptions }
  | { id: number; type: 'ratio'; ratio: string; others: string[] }
  | { id: number; type: 'encode'; rgb: ArrayBuffer; model: CameraModel }
  | { id: number; type: 'script'; model: CameraModel; count: number }
  | { id: number; type: 'inspect'; raw: ArrayBuffer }
  | { id: number; type: 'heartbeat'; token: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const need = (): Engine => { if (!engine) throw Object.assign(new Error('no firmware'), { code: 'no-firmware' }); return engine; };

ctx.onmessage = async (ev: MessageEvent<Req>) => {
  const m = ev.data;
  const progress = (f: number): void => ctx.postMessage({ id: m.id, progress: f });
  try {
    switch (m.type) {
      case 'open': {
        engine = await Engine.open(new Uint8Array(m.raw));
        ctx.postMessage({ id: m.id, ok: true, result: engine.info });
        break;
      }
      case 'convert': ctx.postMessage({ id: m.id, ok: true, result: need().convertPreset(m.kind, m.text, progress) }); break;
      case 'build': {
        const r = await need().buildFirmware(m.requests, m.ratios || [], m.softFocus || [], m.options || {});
        ctx.postMessage({ id: m.id, ok: true, result: r }, [r.file.buffer as ArrayBuffer]);
        break;
      }
      case 'encode': {
        const r = need().encodeShutdownImage(new Uint8Array(m.rgb), m.model, progress);
        ctx.postMessage({ id: m.id, ok: true, result: r }, [r.data.buffer as ArrayBuffer, r.preview.buffer as ArrayBuffer]);
        break;
      }
      case 'ratio': ctx.postMessage({ id: m.id, ok: true, result: need().previewRatio(m.ratio, m.others) }); break;
      case 'script': ctx.postMessage({ id: m.id, ok: true, result: need().rotationScript(m.model, m.count) }); break;
      case 'inspect': ctx.postMessage({ id: m.id, ok: true, result: await need().inspect(new Uint8Array(m.raw)) }); break;
      case 'heartbeat': {
        // keeps the shell alive while the window is hidden (page timers are throttled, worker timers less so)
        const beat = (): void => { fetch('/api/ping', { headers: { 'X-GRMod-Token': m.token }, cache: 'no-store' }).catch(() => undefined); };
        beat(); setInterval(beat, 5000);
        ctx.postMessage({ id: m.id, ok: true, result: true });
        break;
      }
    }
  } catch (e) {
    const err = e as { code?: string; message?: string; details?: unknown };
    ctx.postMessage({ id: m.id, ok: false, error: { code: err.code || 'error', message: err.message || String(e), details: err.details } });
  }
};
