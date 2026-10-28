// SPDX-License-Identifier: GPL-2.0-only
/** Print the gain map module's tables as JSON (for tools/hdrgain/check.py): npx vite-node tools/hdrgain/tables.ts */
import { hdrTables, ZIGZAG, HDR_GAIN, HDR_STATE_WORD, WRITER_VTABLE } from '../../core/src/fw/aspect/hdrgain';
import { HDRGAIN_CODE } from '../../core/src/fw/aspect/hdrgain-code';

const t = hdrTables();
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
console.log(JSON.stringify({
  code: [...t.code], recip: t.recip, half: t.half, dc: t.dc, ac: t.ac, zigzag: ZIGZAG,
  head: hex(t.head), sof: t.sof, xmpPre: hex(t.xmpPre), xmpPost: hex(t.xmpPost), iso: hex(t.iso),
  module: Buffer.from(HDRGAIN_CODE, 'base64').toString('hex'), params: HDR_GAIN, stateWord: HDR_STATE_WORD, vtable: WRITER_VTABLE,
}));
