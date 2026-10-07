// Reader for Adobe Camera Raw / Lightroom .xmp files: Look profiles (PresetType="Look") and presets
// that embed a Look. Extracts what the look model needs: RGBTable (3D LUT), LookTable (HSV table),
// point tone curves; and reports adjustments the model does not cover.
// No DOM is used (DOMParser does not exist in Web Workers): a small XML reader is included.
import { unzlibSync } from 'fflate';
import { ColorError } from './math';

export type CurvePoints = [number, number][];

export interface ToneCurves {
  /** Points in 0..255 as written in the file; null = not present (identity). */
  master: CurvePoints | null;
  red: CurvePoints | null;
  green: CurvePoints | null;
  blue: CurvePoints | null;
}

export interface RgbTable {
  div: number;
  /** div^3 x 3 values in 0..1; entry for grid index (r, g, b) starts at ((r*div + g)*div + b)*3. */
  lut: Float64Array;
  primaries: string;
  gamma: string;
  gamut: number;
  minAmount: number;
  maxAmount: number;
}

export interface LookTable {
  hd: number;
  sd: number;
  vd: number;
  /** 0 = value axis linear, 1 = value axis sRGB-encoded. */
  encoding: number;
  /** vd*hd*sd x 3 (hue shift in degrees, saturation scale, value scale); entry (v, h, s) starts at ((v*hd + h)*sd + s)*3. */
  data: Float64Array;
}

export interface XmpLook {
  title: string;
  rgbTable: RgbTable | null;
  lookTable: LookTable | null;
  /** Curves of the look (or of the file itself when it has no embedded crs:Look). */
  curves: ToneCurves;
  /** Curves of the surrounding preset when the look is embedded in a preset; otherwise null. */
  presetCurves: ToneCurves | null;
  /** crs:Amount if present. */
  amount: number | null;
  warnings: string[];
  /** Names of non-neutral adjustments the model does not reproduce. */
  unsupported: string[];
}

// ---------------------------------------------------------------- minimal XML reader

interface XmlNode {
  name: string;
  attrs: Map<string, string>;
  children: XmlNode[];
  text: string;
}

const NS_PREFIX: Record<string, string> = {
  'http://ns.adobe.com/camera-raw-settings/1.0/': 'crs',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf',
  'adobe:ns:meta/': 'x',
  'http://www.w3.org/XML/1998/namespace': 'xml',
};

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

export function unescapeXml(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;
const isNameEnd = (c: number): boolean => isSpace(c) || c === 62 /* > */ || c === 47 /* / */ || c === 61 /* = */;

function fail(): never {
  throw new ColorError('not-xmp', 'not a well-formed XMP document');
}

function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: new Map(), children: [], text: '' };
  const stack: XmlNode[] = [root];
  const rawNames: string[] = [''];
  const scopes: Map<string, string>[] = [new Map([['xml', 'http://www.w3.org/XML/1998/namespace']])];
  const n = text.length;
  let i = 0;
  const qualify = (raw: string, scope: Map<string, string>, isAttr: boolean): string => {
    const colon = raw.indexOf(':');
    if (colon < 0) {
      if (isAttr) return raw;
      const uri = scope.get('');
      const canon = uri !== undefined ? NS_PREFIX[uri] : undefined;
      return canon ? canon + ':' + raw : raw;
    }
    const uri = scope.get(raw.slice(0, colon));
    const canon = uri !== undefined ? NS_PREFIX[uri] : undefined;
    return canon ? canon + ':' + raw.slice(colon + 1) : raw;
  };
  while (i < n) {
    const lt = text.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += unescapeXml(text.slice(i));
      break;
    }
    if (lt > i) top.text += unescapeXml(text.slice(i, lt));
    const c1 = text.charCodeAt(lt + 1);
    if (c1 === 33 /* ! */) {
      if (text.startsWith('<!--', lt)) {
        const e = text.indexOf('-->', lt + 4);
        if (e < 0) fail();
        i = e + 3;
      } else if (text.startsWith('<![CDATA[', lt)) {
        const e = text.indexOf(']]>', lt + 9);
        if (e < 0) fail();
        top.text += text.slice(lt + 9, e);
        i = e + 3;
      } else {
        const e = text.indexOf('>', lt);
        if (e < 0) fail();
        i = e + 1;
      }
      continue;
    }
    if (c1 === 63 /* ? */) {
      const e = text.indexOf('?>', lt + 2);
      if (e < 0) fail();
      i = e + 2;
      continue;
    }
    if (c1 === 47 /* / */) {
      const e = text.indexOf('>', lt);
      if (e < 0) fail();
      const raw = text.slice(lt + 2, e).trim();
      if (stack.length < 2 || rawNames[rawNames.length - 1] !== raw) fail();
      stack.pop();
      rawNames.pop();
      scopes.pop();
      i = e + 1;
      continue;
    }
    // start tag
    let p = lt + 1;
    let q = p;
    while (q < n && !isNameEnd(text.charCodeAt(q))) q++;
    const rawName = text.slice(p, q);
    if (!/^[A-Za-z_][\w.\-]*(:[A-Za-z_][\w.\-]*)?$/.test(rawName)) fail();
    const rawAttrs: [string, string][] = [];
    let selfClose = false;
    p = q;
    for (;;) {
      while (p < n && isSpace(text.charCodeAt(p))) p++;
      if (p >= n) fail();
      const c = text.charCodeAt(p);
      if (c === 62) { p++; break; }
      if (c === 47) {
        if (text.charCodeAt(p + 1) !== 62) fail();
        selfClose = true;
        p += 2;
        break;
      }
      q = p;
      while (q < n && !isNameEnd(text.charCodeAt(q))) q++;
      const an = text.slice(p, q);
      if (an === '') fail();
      p = q;
      while (p < n && isSpace(text.charCodeAt(p))) p++;
      if (text.charCodeAt(p) !== 61) fail();
      p++;
      while (p < n && isSpace(text.charCodeAt(p))) p++;
      const quote = text.charCodeAt(p);
      if (quote !== 34 && quote !== 39) fail();
      const e = text.indexOf(quote === 34 ? '"' : "'", p + 1);
      if (e < 0) fail();
      rawAttrs.push([an, text.slice(p + 1, e)]);
      p = e + 1;
    }
    let scope = scopes[scopes.length - 1];
    let ownScope = false;
    for (const [an, av] of rawAttrs) {
      if (an === 'xmlns' || an.startsWith('xmlns:')) {
        if (!ownScope) { scope = new Map(scope); ownScope = true; }
        scope.set(an === 'xmlns' ? '' : an.slice(6), unescapeXml(av));
      }
    }
    const node: XmlNode = { name: qualify(rawName, scope, false), attrs: new Map(), children: [], text: '' };
    for (const [an, av] of rawAttrs) {
      if (an === 'xmlns' || an.startsWith('xmlns:')) continue;
      node.attrs.set(qualify(an, scope, true), unescapeXml(av));
    }
    top.children.push(node);
    if (!selfClose) {
      stack.push(node);
      rawNames.push(rawName);
      scopes.push(scope);
    }
    i = p;
  }
  if (stack.length !== 1) fail();
  return root;
}

function findFirst(node: XmlNode, name: string): XmlNode | null {
  if (node.name === name) return node;
  for (const c of node.children) {
    const r = findFirst(c, name);
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------- RDF property bags

/** crs: properties of one RDF struct: simple values (attributes or text-only elements) and structured children. */
interface Bag {
  simple: Map<string, string>;
  struct: Map<string, XmlNode>;
}

const emptyBag = (): Bag => ({ simple: new Map(), struct: new Map() });

function addToBag(bag: Bag, node: XmlNode): void {
  for (const [k, v] of node.attrs) if (k.startsWith('crs:') && !bag.simple.has(k.slice(4))) bag.simple.set(k.slice(4), v);
  for (const c of node.children) {
    if (!c.name.startsWith('crs:')) continue;
    const key = c.name.slice(4);
    if (c.children.length === 0 && c.attrs.get('rdf:parseType') !== 'Resource') {
      if (!bag.simple.has(key)) bag.simple.set(key, c.text.trim());
    } else if (!bag.struct.has(key)) bag.struct.set(key, c);
  }
}

/** The node carrying the fields of a struct-valued property: its rdf:Description, or itself (parseType="Resource"). */
function structOf(node: XmlNode): XmlNode {
  return node.children.find((c) => c.name === 'rdf:Description') ?? node;
}

function seqItems(bag: Bag, key: string): string[] | null {
  const node = bag.struct.get(key);
  if (!node) return null;
  const seq = node.children.find((c) => c.name === 'rdf:Seq' || c.name === 'rdf:Bag');
  if (!seq) return null;
  return seq.children.filter((c) => c.name === 'rdf:li').map((c) => c.text.trim());
}

function altText(bag: Bag, key: string): string | null {
  const node = bag.struct.get(key);
  if (node) {
    const alt = node.children.find((c) => c.name === 'rdf:Alt');
    const items = (alt ?? node).children.filter((c) => c.name === 'rdf:li');
    const pick = items.find((c) => c.attrs.get('xml:lang') === 'x-default') ?? items[0];
    if (pick) return pick.text.trim();
  }
  const s = bag.simple.get(key);
  return s === undefined ? null : s.trim();
}

// ---------------------------------------------------------------- table decoding

const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?`\'|()[]{}@%$#';
const IDX = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHA.length; i++) IDX[ALPHA.charCodeAt(i)] = i;
const POW85 = [1, 85, 85 * 85, 85 * 85 * 85, 85 * 85 * 85 * 85];

/** Decode the text of a crs:Table_<id> attribute (already XML-unescaped) into the raw table bytes. */
export function decodeTableText(t: string): Uint8Array {
  const out = new Uint8Array(Math.ceil(t.length / 5) * 4);
  let o = 0;
  let x = 0;
  let k = 0;
  for (let i = 0; i < t.length; i++) {
    const code = t.charCodeAt(i);
    if (isSpace(code)) continue;
    const v = code < 128 ? IDX[code] : -1;
    if (v < 0) throw new ColorError('bad-table', 'table text contains an invalid character');
    x += v * POW85[k++];
    if (k === 5) {
      const u = x >>> 0;
      out[o++] = u & 255; out[o++] = (u >>> 8) & 255; out[o++] = (u >>> 16) & 255; out[o++] = u >>> 24;
      x = 0;
      k = 0;
    }
  }
  if (k) {
    const u = x >>> 0;
    const b = [u & 255, (u >>> 8) & 255, (u >>> 16) & 255, u >>> 24];
    for (let j = 0; j < k - 1; j++) out[o++] = b[j];
  }
  if (o < 6) throw new ColorError('bad-table', 'table data is too short');
  const expect = (out[0] | (out[1] << 8) | (out[2] << 16) | (out[3] << 24)) >>> 0;
  let raw: Uint8Array;
  try {
    raw = unzlibSync(out.subarray(4, o));
  } catch {
    throw new ColorError('bad-table', 'table data could not be decompressed');
  }
  if (raw.length !== expect) throw new ColorError('bad-table', 'table data has the wrong length');
  return raw;
}

const PRIMARIES = ['sRGB', 'Adobe', 'ProPhoto', 'P3', 'Rec2020'];
const GAMMAS = ['linear', 'sRGB', '1.8', '2.2', 'Rec2020'];

function parseRgbTable(raw: Uint8Array): RgbTable {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.length < 16) throw new ColorError('bad-table', 'RGB table is truncated');
  const typ = dv.getUint32(0, true), dims = dv.getUint32(8, true), div = dv.getUint32(12, true);
  if (typ !== 1 || dims !== 3) throw new ColorError('unsupported-table', `RGB table of type ${typ} with ${dims} dimension(s) is not supported`);
  if (div < 2 || div > 128) throw new ColorError('unsupported-table', `RGB table with ${div} divisions is not supported`);
  const count = div * div * div * 3;
  const o = 16 + count * 2;
  if (raw.length < o + 28) throw new ColorError('bad-table', 'RGB table is truncated');
  const ident = new Int32Array(div);
  for (let i = 0; i < div; i++) ident[i] = Math.floor((i * 0xffff + (div >> 1)) / (div - 1));
  const lut = new Float64Array(count);
  let p = 16;
  let w = 0;
  for (let r = 0; r < div; r++)
    for (let g = 0; g < div; g++)
      for (let b = 0; b < div; b++) {
        lut[w++] = ((dv.getUint16(p, true) + ident[r]) & 0xffff) / 65535.0;
        lut[w++] = ((dv.getUint16(p + 2, true) + ident[g]) & 0xffff) / 65535.0;
        lut[w++] = ((dv.getUint16(p + 4, true) + ident[b]) & 0xffff) / 65535.0;
        p += 6;
      }
  const prim = dv.getUint32(o, true), gam = dv.getUint32(o + 4, true), gamut = dv.getUint32(o + 8, true);
  const primaries = PRIMARIES[prim] ?? String(prim);
  const gamma = GAMMAS[gam] ?? String(gam);
  if (primaries !== 'sRGB' || gamma !== 'sRGB')
    throw new ColorError('unsupported-table', `RGB table in ${primaries} primaries / ${gamma} gamma is not supported (only sRGB / sRGB)`);
  return { div, lut, primaries, gamma, gamut, minAmount: dv.getFloat64(o + 12, true), maxAmount: dv.getFloat64(o + 20, true) };
}

function parseLookTable(raw: Uint8Array): LookTable {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.length < 20) throw new ColorError('bad-table', 'look table is truncated');
  const typ = dv.getUint32(0, true), hd = dv.getUint32(8, true), sd = dv.getUint32(12, true), vd = dv.getUint32(16, true);
  if (typ !== 0) throw new ColorError('unsupported-table', `look table of type ${typ} is not supported`);
  if (hd < 1 || sd < 2 || vd < 1 || hd > 360 || sd > 256 || vd > 256)
    throw new ColorError('unsupported-table', `look table with dimensions ${hd}x${sd}x${vd} is not supported`);
  const count = hd * sd * vd * 3;
  if (raw.length < 20 + count * 4) throw new ColorError('bad-table', 'look table is truncated');
  const data = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const v = dv.getFloat32(20 + i * 4, true);
    if (!Number.isFinite(v)) throw new ColorError('bad-table', 'look table contains a non-finite value');
    data[i] = v;
  }
  const encoding = raw.length >= 24 + count * 4 ? dv.getUint32(20 + count * 4, true) : 0;
  if (encoding !== 0 && encoding !== 1) throw new ColorError('unsupported-table', `look table value encoding ${encoding} is not supported`);
  return { hd, sd, vd, encoding, data };
}

// ---------------------------------------------------------------- settings

const CURVE_KEYS: [keyof ToneCurves, string][] = [
  ['master', 'ToneCurvePV2012'],
  ['red', 'ToneCurvePV2012Red'],
  ['green', 'ToneCurvePV2012Green'],
  ['blue', 'ToneCurvePV2012Blue'],
];

function readCurve(bag: Bag, key: string): CurvePoints | null {
  const items = seqItems(bag, key);
  if (!items) return null;
  const pts: CurvePoints = [];
  for (const it of items) {
    const parts = it.split(',');
    if (parts.length !== 2) continue;
    const x = Number(parts[0]), y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || parts[0].trim() === '' || parts[1].trim() === '') continue;
    if (pts.length && x <= pts[pts.length - 1][0]) continue; // abscissae must increase
    pts.push([x, y]);
  }
  return pts.length >= 2 ? pts : null;
}

function readCurves(bag: Bag): ToneCurves {
  const c: ToneCurves = { master: null, red: null, green: null, blue: null };
  for (const [slot, key] of CURVE_KEYS) c[slot] = readCurve(bag, key);
  return c;
}

/** True when the curve is absent or the diagonal. */
export function isIdentityCurve(p: CurvePoints | null): boolean {
  return !p || (p[0][0] <= 0 && p[p.length - 1][0] >= 255 && p.every(([x, y]) => x === y));
}

const anyCurve = (c: ToneCurves | null): boolean =>
  !!c && !(isIdentityCurve(c.master) && isIdentityCurve(c.red) && isIdentityCurve(c.green) && isIdentityCurve(c.blue));
const anyRgbCurve = (c: ToneCurves | null): boolean =>
  !!c && !(isIdentityCurve(c.red) && isIdentityCurve(c.green) && isIdentityCurve(c.blue));

// Adjustments that change colour or tone and that the look model does not reproduce; non-zero = in use.
const UNSUPPORTED_ZERO: RegExp[] = [
  /^(Exposure|Contrast|Highlights|Shadows|Whites|Blacks|Clarity)2012$/,
  /^(Texture|Dehaze|Vibrance|Saturation)$/,
  /^Parametric(Shadows|Darks|Lights|Highlights)$/,
  /^(Hue|Saturation|Luminance)Adjustment[A-Za-z]+$/,
  /^SplitToning[A-Za-z]*Saturation$/,
  /^ColorGrade[A-Za-z]*(Sat|Lum)$/,
  /^(Red|Green|Blue)(Hue|Saturation)$/,
  /^ShadowTint$/,
  /^GrainAmount$/,
  /^PostCropVignetteAmount$/,
  /^Incremental(Temperature|Tint)$/,
];

function collectUnsupported(bags: Bag[]): string[] {
  const found: string[] = [];
  const add = (name: string): void => { if (!found.includes(name)) found.push(name); };
  for (const bag of bags) {
    for (const [key, value] of bag.simple) {
      if (UNSUPPORTED_ZERO.some((re) => re.test(key))) {
        const v = parseFloat(value);
        if (Number.isFinite(v) && v !== 0) add(key);
      } else if (key === 'ConvertToGrayscale') {
        if (value.trim().toLowerCase() === 'true') add(key);
      } else if (key === 'CurveRefineSaturation') {
        const v = parseFloat(value);
        if (Number.isFinite(v) && v !== 100) add(key);
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------- entry point

/** Parse an .xmp Look profile or preset. Throws ColorError (see codes in math.ts). */
export function parseXmp(text: string): XmpLook {
  if (typeof text !== 'string') throw new ColorError('not-xmp', 'no text');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!/<[A-Za-z_?!]/.test(text)) throw new ColorError('not-xmp', 'not an XML document');
  const root = parseXml(text);
  const rdf = findFirst(root, 'rdf:RDF');
  if (!rdf) throw new ColorError('not-xmp', 'no rdf:RDF element');
  const descriptions = rdf.children.filter((c) => c.name === 'rdf:Description');
  if (descriptions.length === 0) throw new ColorError('not-xmp', 'no rdf:Description element');

  const top = emptyBag();
  for (const d of descriptions) addToBag(top, d);

  // A preset can embed a Look: crs:Look / rdf:Description [@crs:Name @crs:UUID @crs:Amount] / crs:Parameters / rdf:Description
  const lookEl = top.struct.get('Look') ?? null;
  const lookDesc = emptyBag();
  const lookParams = emptyBag();
  if (lookEl) {
    addToBag(lookDesc, structOf(lookEl));
    const paramsEl = lookDesc.struct.get('Parameters');
    if (paramsEl) addToBag(lookParams, structOf(paramsEl));
  }
  const lookUuid = (lookDesc.simple.get('UUID') ?? '').trim();
  const embedded = lookEl !== null && (lookUuid !== '' || lookParams.simple.size > 0 || lookParams.struct.size > 0);
  // Bag holding the look's own settings, and every bag in lookup order.
  const main = embedded ? lookParams : top;
  const bags = embedded ? [lookParams, lookDesc, top] : [top];

  const tableText = (id: string): string | null => {
    for (const b of bags) {
      const t = b.simple.get('Table_' + id);
      if (t !== undefined && t.trim() !== '') return t;
    }
    return null;
  };
  const refOf = (key: string): string | null => {
    for (const b of embedded ? [lookParams, lookDesc] : [top]) {
      const v = b.simple.get(key);
      if (v !== undefined && v.trim() !== '') return v.trim();
    }
    return null;
  };

  const rgbId = refOf('RGBTable');
  const lookId = refOf('LookTable');
  const rgbText = rgbId ? tableText(rgbId) : null;
  const lookText = lookId ? tableText(lookId) : null;
  if ((rgbId && rgbText === null) || (lookId && lookText === null))
    throw new ColorError('look-profile-missing', 'the file refers to a profile table that is not embedded in it');

  const curves = readCurves(main);
  const presetCurves = embedded ? readCurves(top) : null;

  if (embedded && lookUuid !== '' && !rgbText && !lookText && !anyCurve(curves))
    throw new ColorError('look-profile-missing', 'the preset points at a profile that is not embedded in the file');
  if (!rgbText && !lookText && !anyCurve(curves) && !anyCurve(presetCurves))
    throw new ColorError('no-table', 'the file contains no colour table and no tone curve');

  const rgbTable = rgbText ? parseRgbTable(decodeTableText(rgbText)) : null;
  const lookTable = lookText ? parseLookTable(decodeTableText(lookText)) : null;

  const warnings: string[] = [];
  let amount: number | null = null;
  for (const b of embedded ? [lookDesc, top] : [top]) {
    const a = b.simple.get('Amount');
    if (a === undefined || amount !== null) continue;
    const v = parseFloat(a);
    if (Number.isFinite(v)) amount = v;
  }
  if (amount !== null && Math.abs(amount - 1) > 1e-9) warnings.push('amount-ignored');
  if (anyRgbCurve(curves) || anyRgbCurve(presetCurves)) warnings.push('rgb-curves-approx');
  if (embedded && anyCurve(presetCurves)) warnings.push('preset-curve-approx');

  const title = [altText(top, 'Name'), lookDesc.simple.get('Name'), altText(lookDesc, 'Name')]
    .map((s) => (s ?? '').trim())
    .find((s) => s !== '') ?? '';

  return {
    title,
    rgbTable,
    lookTable,
    curves,
    presetCurves,
    amount,
    warnings,
    unsupported: collectUnsupported(embedded ? [top, lookParams] : [top]),
  };
}
