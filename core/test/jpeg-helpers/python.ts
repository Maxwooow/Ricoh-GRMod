// Runs the Pillow helper script. Tests that need it are skipped when Python or
// Pillow is not installed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'pyjpeg.py');

function run(args: string[]): { ok: boolean; json: any; stderr: string } {
  const r = spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.error || r.status !== 0) return { ok: false, json: null, stderr: String(r.error ?? r.stderr) };
  try {
    return { ok: true, json: JSON.parse(r.stdout.trim().split('\n').pop() as string), stderr: r.stderr };
  } catch {
    return { ok: false, json: null, stderr: `unexpected output: ${r.stdout}` };
  }
}

function must(args: string[]): any {
  const r = run(args);
  if (!r.ok) throw new Error(`pyjpeg.py ${args[0]} failed: ${r.stderr}`);
  return r.json;
}

/** Pillow version, or null when python3 / Pillow cannot be used. */
export const pillowVersion: string | null = (() => {
  const r = run(['probe']);
  return r.ok ? String(r.json.pillow) : null;
})();

let workDir: string | null = null;
/** A scratch directory for the files exchanged with Python (removed by `cleanup`). */
export function scratch(): string {
  if (!workDir) workDir = mkdtempSync(join(tmpdir(), 'grmod-jpeg-test-'));
  return workDir;
}
export function cleanup(): void {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
}

let counter = 0;
const tempName = (ext: string): string => join(scratch(), `f${counter++}.${ext}`);

/** Cut the standard 720x480 test images out of a large photo: name -> RGB bytes. */
export function photoCrops(photoPath: string): Record<string, Uint8Array> {
  const files = must(['crops', photoPath, scratch()]) as Record<string, string>;
  const out: Record<string, Uint8Array> = {};
  for (const [name, path] of Object.entries(files)) out[name] = new Uint8Array(readFileSync(path));
  return out;
}

/** Decode a JPEG with Pillow (libjpeg). */
export function pillowDecode(jpeg: Uint8Array): { width: number; height: number; rgb: Uint8Array; progressive: boolean; layers: number[][] } {
  const src = tempName('jpg');
  const dst = tempName('rgb');
  writeFileSync(src, jpeg);
  const info = must(['decode', src, dst]);
  return { width: info.width, height: info.height, rgb: new Uint8Array(readFileSync(dst)), progressive: info.progressive, layers: info.layers };
}

/** Encode RGB with Pillow (libjpeg). */
export function pillowEncode(
  rgb: Uint8Array,
  width: number,
  height: number,
  opts: { quality: number; subsampling: '4:4:4' | '4:2:2' | '4:2:0'; progressive?: boolean; optimize?: boolean },
): Uint8Array {
  const src = tempName('rgb');
  const dst = tempName('jpg');
  writeFileSync(src, rgb);
  const flags = [opts.progressive ? 'progressive' : '', opts.optimize ? 'optimize' : ''].filter(Boolean);
  must(['encode', src, String(width), String(height), dst, String(opts.quality), opts.subsampling, ...flags]);
  return new Uint8Array(readFileSync(dst));
}
