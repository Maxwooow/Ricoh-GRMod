import { readFileSync, writeFileSync } from 'node:fs';
import { Engine, fw } from './core/src';
import {
  HDR_INTENSE_TABLE_0, HDR_INTENSE_TABLE_1, HDR_INTENSE_TABLE_2, HDR_INTENSE_TABLE_3,
  HDR_INTENSE_COUNT_CMP, HDR_INTENSE_COUNT_MOV, HDR_INTENSE_ASCII_CMP,
  HDR_FORMATTER1_MOV, HDR_FORMATTER1_B, HDR_FORMATTER2_MOV, HDR_FORMATTER2_B,
  HOOK_SITE, romVa, T_REC_BASE, T_GAM_BASE, T_MA_BASE, TARGET_TONE_ID, STD_MA_DESC_VA
} from './core/src/fw/aspect/hlg';

async function main() {
  const official = readFileSync('./core/testdata/private/official.bin');
  const eng = await Engine.open(official);
  console.log('Opened official, model:', eng.info.model, 'ver:', eng.info.version);
  const res = await eng.buildFirmware([], [], [], { hlgPhoto: true });
  console.log('Build completed. Self-checks:', res.checks);
  
  // Inspect modified firmware using inspect()
  const inspectInfo = await eng.inspect(res.file);
  console.log('Inspected built file:', inspectInfo);

  const parsed = fw.parseFrames(res.file);
  const sections = fw.sectionsOf(parsed.decoded);
  const rtos = sections.find(s => s.name === 'RTOS')!;
  const rtosData = fw.sectionData(parsed.decoded, rtos);
  const rtosVa = (va: number) => {
    const off = va - 0x53000000;
    return new DataView(rtosData.buffer, rtosData.byteOffset + off, 4).getUint32(0, true);
  };

  console.log('Table 0:', '0x' + rtosVa(HDR_INTENSE_TABLE_0).toString(16));
  console.log('Table 1:', '0x' + rtosVa(HDR_INTENSE_TABLE_1).toString(16));
  console.log('Table 2:', '0x' + rtosVa(HDR_INTENSE_TABLE_2).toString(16));
  console.log('Table 3:', '0x' + rtosVa(HDR_INTENSE_TABLE_3).toString(16));
  console.log('Count cmp:', '0x' + rtosVa(HDR_INTENSE_COUNT_CMP).toString(16));
  console.log('Count mov:', '0x' + rtosVa(HDR_INTENSE_COUNT_MOV).toString(16));
  console.log('Ascii cmp:', '0x' + rtosVa(HDR_INTENSE_ASCII_CMP).toString(16));
  console.log('Formatter1 mov:', '0x' + rtosVa(HDR_FORMATTER1_MOV).toString(16));
  console.log('Formatter1 b:', '0x' + rtosVa(HDR_FORMATTER1_B).toString(16));
  console.log('Formatter2 mov:', '0x' + rtosVa(HDR_FORMATTER2_MOV).toString(16));
  console.log('Formatter2 b:', '0x' + rtosVa(HDR_FORMATTER2_B).toString(16));

  const outPath = 'D:/Ricoh GR4 firmware Mod/firmware/fwdc248b_hlg_level0.bin';
  writeFileSync(outPath, res.file);
  console.log('Exported firmware to:', outPath);
}

main().catch(console.error);
