// Test helpers: build small synthetic Camera Raw tables and .xmp documents (no commercial data).
import { zlibSync } from 'fflate';

const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?`\'|()[]{}@%$#';

/** Inverse of decodeTableText: 4-byte length + zlib stream, written as little-endian base-85 groups. */
export function encodeTableText(raw: Uint8Array): string {
  const z = zlibSync(raw);
  const bytes = new Uint8Array(4 + z.length);
  new DataView(bytes.buffer).setUint32(0, raw.length, true);
  bytes.set(z, 4);
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const n = Math.min(4, bytes.length - i);
    let x = 0;
    for (let k = 0; k < n; k++) x += bytes[i + k] * 2 ** (8 * k);
    const chars = n === 4 ? 5 : n + 1;
    for (let k = 0; k < chars; k++) {
      out += ALPHA[x % 85];
      x = Math.floor(x / 85);
    }
  }
  return out;
}

export function makeRgbTable(div: number, fn: (r: number, g: number, b: number) => [number, number, number], primaries = 0, gamma = 1, type = 1, dims = 3): Uint8Array {
  const n = div * div * div * 3;
  const raw = new Uint8Array(16 + n * 2 + 28);
  const dv = new DataView(raw.buffer);
  dv.setUint32(0, type, true); dv.setUint32(4, 1, true); dv.setUint32(8, dims, true); dv.setUint32(12, div, true);
  const ident = (i: number): number => Math.floor((i * 0xffff + (div >> 1)) / (div - 1));
  let p = 16;
  for (let r = 0; r < div; r++)
    for (let g = 0; g < div; g++)
      for (let b = 0; b < div; b++) {
        const v = fn(r / (div - 1), g / (div - 1), b / (div - 1));
        const id = [ident(r), ident(g), ident(b)];
        for (let c = 0; c < 3; c++) {
          const q = Math.max(0, Math.min(65535, Math.round(v[c] * 65535)));
          dv.setUint16(p, (q - id[c]) & 0xffff, true);
          p += 2;
        }
      }
  dv.setUint32(p, primaries, true); dv.setUint32(p + 4, gamma, true); dv.setUint32(p + 8, 0, true);
  dv.setFloat64(p + 12, 0, true); dv.setFloat64(p + 20, 2, true);
  return raw;
}

export function makeLookTable(hd: number, sd: number, vd: number, fn: (h: number, s: number, v: number) => [number, number, number], encoding = 0): Uint8Array {
  const n = hd * sd * vd * 3;
  const raw = new Uint8Array(20 + n * 4 + 4);
  const dv = new DataView(raw.buffer);
  dv.setUint32(0, 0, true); dv.setUint32(4, 1, true); dv.setUint32(8, hd, true); dv.setUint32(12, sd, true); dv.setUint32(16, vd, true);
  let p = 20;
  for (let v = 0; v < vd; v++)
    for (let h = 0; h < hd; h++)
      for (let s = 0; s < sd; s++) {
        const e = fn(h, s, v);
        for (let c = 0; c < 3; c++) { dv.setFloat32(p, e[c], true); p += 4; }
      }
  dv.setUint32(p, encoding, true);
  return raw;
}

export const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function curveXml(name: string, pts: [number, number][]): string {
  return `<crs:${name}><rdf:Seq>${pts.map((p) => `<rdf:li>${p[0]}, ${p[1]}</rdf:li>`).join('')}</rdf:Seq></crs:${name}>`;
}

/** A minimal XMP document: `attrs` are written as attributes of the top rdf:Description, `body` as its children. */
export function xmpDoc(attrs: Record<string, string>, body = ''): string {
  const a = Object.entries(attrs).map(([k, v]) => `   crs:${k}="${escapeXml(v)}"`).join('\n');
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="test">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
${a}>
${body}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;
}

export const nameXml = (title: string): string =>
  `<crs:Name><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li></rdf:Alt></crs:Name>`;
