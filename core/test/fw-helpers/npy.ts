/** Minimal reader for the .npy files used as icon fixtures: uint8, C order, any shape. */
export interface NpyArray {
  shape: number[];
  data: Uint8Array;
}

export function parseNpyU8(bytes: Uint8Array): NpyArray {
  const magic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) throw new Error('not an .npy file');
  const major = bytes[6];
  if (major !== 1) throw new Error(`unsupported .npy version ${major}.${bytes[7]}`);
  const headerLen = bytes[8] | (bytes[9] << 8);
  let header = '';
  for (let i = 0; i < headerLen; i++) header += String.fromCharCode(bytes[10 + i]);
  const descr = /'descr':\s*'([^']+)'/.exec(header);
  const fortran = /'fortran_order':\s*(True|False)/.exec(header);
  const shape = /'shape':\s*\(([^)]*)\)/.exec(header);
  if (!descr || !fortran || !shape) throw new Error('bad .npy header');
  if (descr[1] !== '|u1' && descr[1] !== 'u1') throw new Error(`expected uint8 data, got ${descr[1]}`);
  if (fortran[1] !== 'False') throw new Error('expected C order');
  const dims = shape[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
  const count = dims.reduce((a, b) => a * b, 1);
  const data = bytes.slice(10 + headerLen, 10 + headerLen + count);
  if (data.length !== count) throw new Error('.npy data is truncated');
  return { shape: dims, data };
}
