// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import type { BuildOptions } from '../src/app/engine';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const files = [
  { version: '1.11', path: P + 'official.bin', table: 0x53dba138, clamp: 0x532681a4, top: 0x532681c4 },
  { version: '1.20', path: process.env.GRMOD_GR4_120_FIRMWARE || P + 'official120.bin', table: 0x53de4968, clamp: 0x53269ffc, top: 0x5326a01c },
];
const stock = [53,63,75,90,110,150,210,260,280,285,290,320,356,470,610,770,930,1050];
const curves = {
  bright: [53,65,80,100,140,210,300,400,480,540,600,660,740,840,970,1130,1320,1500],
  balanced: [53,64,78,96,128,185,265,345,400,435,465,550,660,815,970,1130,1320,1500],
};
function rtos(file: Uint8Array): Uint8Array {
  const d = new fw.Firmware(file).decoded, s = fw.sectionsOf(d).find(x => x.name === 'RTOS')!;
  return d.slice(s.offset, s.offset + s.size);
}
const word = (b: Uint8Array, at: number) => new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(at-0x53000000,true);
for (const f of files) describe.skipIf(!existsSync(f.path))(`brighter Auto ${f.version}`, () => {
  const raw = existsSync(f.path) ? new Uint8Array(readFileSync(f.path)) : new Uint8Array();
  for (const curve of ['bright','balanced'] as const) {
    for (const options of [{guard:false}, {hdrGainMap:true,adjSlots:8}]) {
      it(`${curve}, ${options.hdrGainMap ? 'with HDR/ADJ' : 'with date stamp'}: exact data-only patch and full inspect`, async () => {
        const e = await Engine.open(raw);
        expect(e.info.features.brightAuto).toBe(true);
        const off = await e.buildFirmware([],[],[],{...options,dateStamp:true});
        const on = await e.buildFirmware([],[],[],{...options,dateStamp:true,brightAuto:curve});
        expect(Object.values(on.checks).every(v => v === true)).toBe(true);
        const a=rtos(off.file),b=rtos(on.file);
        expect(stock.map((_,i)=>word(a,f.table+4+i*8))).toEqual(stock);
        expect(curves[curve].map((_,i)=>word(b,f.table+4+i*8))).toEqual(curves[curve]);
        expect(stock.map((_,i)=>word(b,f.table+i*8))).toEqual(stock.map((_,i)=>2**i));
        expect(word(b,f.clamp)).toBe(0xe30035dc);expect(word(b,f.top)).toBe(0xe30005dc);
        // The frame grows only as needed for its recipe; no executable hook is added.
        const allowed=new Set([f.clamp,f.top,...stock.map((_,i)=>f.table+4+i*8)]);
        const recordLength=(v:Uint8Array)=>new DataView(v.buffer,v.byteOffset,v.byteLength).getUint32(v.length-16,true);
        const oldEnd=Math.min(a.length-16-recordLength(a),b.length-16-recordLength(b));
        for(let i=0;i<oldEnd;i+=4) if(word(a,0x53000000+i)!==word(b,0x53000000+i)) expect(allowed.has(0x53000000+i)).toBe(true);
        const summary=await e.inspect(on.file);expect(summary.verified).toBe(true);expect(summary.brightAuto).toBe(curve);
        if(options.hdrGainMap){expect(summary.hdrGainMap).toBe(true);expect(summary.adjSlots).toBe(8);}
      },60000);
    }
  }
  it('omitted and false switches preserve every byte', async () => {
    const e=await Engine.open(raw);
    const a=await e.buildFirmware([],[],[],{dateStamp:true});
    const b=await e.buildFirmware([],[],[],{dateStamp:true,brightAuto:false});
    expect(Buffer.from(a.file).equals(Buffer.from(b.file))).toBe(true);
    expect((await e.inspect(b.file)).brightAuto).toBeUndefined();
  },60000);
  it('true aliases bright; an invalid switch is rejected', async () => {
    const e=await Engine.open(raw);
    const a=await e.buildFirmware([],[],[],{guard:false,brightAuto:true});
    const b=await e.buildFirmware([],[],[],{guard:false,brightAuto:'bright'});
    expect(Buffer.from(a.file).equals(Buffer.from(b.file))).toBe(true);
    expect((await e.inspect(a.file)).verified).toBe(true);
    await expect(e.buildFirmware([],[],[],{brightAuto:'invalid'} as unknown as BuildOptions)).rejects.toMatchObject({code:'bad-edit'});
  },60000);
});
