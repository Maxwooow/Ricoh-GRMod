// Generator for the camera's start-up script (script\startup.ttl on the SD
// card) that installs a different prepared power-off image at every power-on.
//
// The camera runs a small subset of Tera Term Language. Only commands that are
// known to work on the camera are emitted: filesearch, filestat, fileopen,
// fileread, str2code, fileclose, filecreate, filewrite, filecopy, if/endif,
// goto/labels, exit and plain assignments.

export type CameraModel = 'STANDARD' | 'HDF' | 'MONO';

export const MODEL_INFO: Record<CameraModel, { productBytes: [number, number, number, number]; target: string; resourceName: string }> = {
  STANDARD: { productBytes: [0xe0, 0x32, 0x01, 0x00], target: 'A:\\Resource\\Jpeg\\GoodBye.jpg', resourceName: 'GoodBye.jpg' },
  HDF: { productBytes: [0xe1, 0x32, 0x01, 0x00], target: 'A:\\Resource\\Jpeg\\GB_HDF.jpg', resourceName: 'GB_HDF.jpg' },
  MONO: { productBytes: [0x30, 0x33, 0x01, 0x00], target: 'A:\\Resource\\Jpeg\\GB_Mono.jpg', resourceName: 'GB_Mono.jpg' },
};

/** Internal file whose first 8 bytes identify the camera: 4 magic bytes + little-endian product id. */
export const MODEL_FILE = 'E:\\BlkCtl15.bin';
export const MODEL_FILE_MAGIC: readonly [number, number, number, number] = [0xa5, 0x5a, 0x5a, 0xa5];

/** Names of the files on the SD card (its root is `C:\` inside scripts). */
export const CARD_FILES = {
  /** One ASCII digit: number of the image to install at the next power-on. */
  index: 'GBRIDX.TXT',
  /** While this file exists the script does nothing. */
  stop: 'GBRSTOP.TXT',
  /** Firmware update file; while it is on the card the script does nothing. */
  firmware: 'fwdc248b.bin',
  /** Where the camera looks for the start-up script. */
  script: 'script\\startup.ttl',
} as const;

export const MAX_IMAGES = 9;

/** Card file name of image `i` (1..9): `GBR1.JPG` ... `GBR9.JPG`. */
export function imageFileName(i: number): string {
  if (!Number.isInteger(i) || i < 1 || i > MAX_IMAGES) throw new RangeError(`image number must be 1..${MAX_IMAGES}, got ${i}`);
  return `GBR${i}.JPG`;
}

/**
 * The start-up script for one camera model, `count` images (1..9) and the exact
 * byte size every image and the internal target file must have.
 *
 * At each power-on the script
 *  1. exits if the pause file or a firmware update file is on the card;
 *  2. exits unless the first 8 bytes of E:\BlkCtl15.bin identify the chosen model;
 *  3. reads the image number from the index file (anything unusable counts as 1);
 *  4. exits, touching nothing, unless the internal file is exactly `size` bytes;
 *  5. copies the chosen card image over the internal file if that image exists
 *     and is exactly `size` bytes;
 *  6. writes the next image number (wrapping to 1) to the index file.
 *
 * ASCII only, LF line endings, 4-space indentation, ends with a newline.
 */
export function rotationScript(opts: { model: CameraModel; size: number; count: number }): string {
  const info = MODEL_INFO[opts.model];
  if (!info) throw new RangeError(`unknown camera model "${String(opts.model)}"`);
  const { size, count } = opts;
  if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES) throw new RangeError(`count must be 1..${MAX_IMAGES}, got ${count}`);
  if (!Number.isInteger(size) || size < 1 || size > 0x7fffffff) throw new RangeError(`size must be a positive integer, got ${size}`);

  const idxFile = `'C:\\${CARD_FILES.index}'`;
  const image = (i: number): string => `'C:\\${imageFileName(i)}'`;
  const nextDigit = (i: number): string => `'${(i % count) + 1}'`;
  const L: string[] = [];
  const exitIf = (condition: string): void => {
    L.push(`if ${condition} then`, '    exit', 'endif');
  };

  L.push(`; power-off image rotation: ${opts.model}, ${count} image${count === 1 ? '' : 's'}, ${size} bytes`);
  L.push(`filesearch 'C:\\${CARD_FILES.stop}'`);
  exitIf('result <> 0');
  L.push(`filesearch 'C:\\${CARD_FILES.firmware}'`);
  exitIf('result <> 0');

  L.push('; camera model check');
  L.push('sz = -1', `filestat '${MODEL_FILE}' sz`);
  exitIf('sz < 8');
  L.push(`fileopen fh '${MODEL_FILE}' 0`);
  exitIf('fh < 0');
  L.push('ok = 1');
  for (const byte of [...MODEL_FILE_MAGIC, ...info.productBytes]) {
    // `code` is cleared first: a 0x00 byte reads as an empty string, and the check
    // must not depend on whether str2code then stores 0 or leaves `code` alone.
    L.push('code = 0', 'fileread fh 1 chunk', 'str2code code chunk', `if code <> ${byte} then`, '    ok = 0', 'endif');
  }
  L.push('fileclose fh');
  exitIf('ok = 0');
  L.push(`target = '${info.target}'`);

  L.push('; image number for this power-on');
  L.push('idx = 49', 'sz = -1', `filestat ${idxFile} sz`);
  L.push('if sz <> 1 then', '    goto pick', 'endif');
  L.push(`fileopen fh ${idxFile} 0`);
  L.push('if fh < 0 then', '    goto pick', 'endif');
  L.push('fileread fh 1 chunk', 'str2code idx chunk', 'fileclose fh');
  L.push(':pick');
  L.push(`src = ${image(1)}`, `nxt = ${nextDigit(1)}`);
  for (let i = 2; i <= count; i++) {
    L.push(`if idx = ${48 + i} then`, `    src = ${image(i)}`, `    nxt = ${nextDigit(i)}`, 'endif');
  }

  L.push('; never touch an internal file of unexpected size');
  L.push('sz = -1', 'filestat target sz');
  exitIf(`sz <> ${size}`);
  L.push('ok = 1', 'sz = -1', 'filestat src sz');
  L.push(`if sz <> ${size} then`, '    ok = 0', 'endif');
  L.push('if ok = 1 then', '    filecopy src target', 'endif');
  L.push(`filecreate fh ${idxFile}`);
  exitIf('fh < 0');
  L.push('filewrite fh nxt', 'fileclose fh', 'exit');
  return L.join('\n') + '\n';
}
