"""Execute the IIIx JPEG Exif creation/setter/size/layout/serialization on ARM.

Only heap services and the final byte/word output stream are substituted. Camera
capture, filesystem I/O, compression and boot are not emulated. Synthetic JPEG
fixtures contain the actual native-serialized Exif IFD, not camera-test evidence.
"""
import argparse, hashlib, io, json, struct
from pathlib import Path
from unicorn import arm_const as reg
from adj_probe import AdjProbe, put, u32
from native_probe import OBJECT, OUTPUT

WRITER, COMMON, OTHER = OBJECT, OBJECT+0x2000, OBJECT+0x4000
HEAP_SERVICE, VECTOR_SERVICE = 0x62080000, 0x62080100
STREAM, CALLS = 0x62080200, 0x62081000

class JpegProbe(AdjProbe):
    def __init__(self, data, manifest):
        super().__init__(data, manifest)
        self.uc.mem_map(0x55357000, 0x2000)
        put(self.uc,0x55357b78,1);put(self.uc,0x55357b7c,0x53d2e208)
        self.uc.mem_map(0x63000000,0x200000)
        self.heap=0x63000020;self.allocations=[];self.serial=bytearray();self.writes=[]
        for obj,vt in ((HEAP_SERVICE,HEAP_SERVICE+0x40),(VECTOR_SERVICE,VECTOR_SERVICE+0x40),(STREAM,STREAM+0x40)):
            put(self.uc,obj,vt)
        for off,call in ((8,CALLS),(12,CALLS+4)):
            put(self.uc,HEAP_SERVICE+0x40+off,call)
        for off,call in ((8,CALLS+8),(12,CALLS+4)):
            put(self.uc,VECTOR_SERVICE+0x40+off,call)
        for off,call in ((8,CALLS+16),(12,CALLS+20),(16,CALLS+24),(0x24,CALLS+28)):
            put(self.uc,STREAM+0x40+off,call)
        self.uc.mem_write(CALLS,struct.pack('<I',0xe12fff1e)*8)

    def _hook(self,cpu,at,size,user):
        result=None
        if at==0x536abf18: result=HEAP_SERVICE
        elif at==0x53585a68: result=VECTOR_SERVICE
        elif at in (CALLS,CALLS+8):
            size=cpu.reg_read(reg.UC_ARM_REG_R1)*(4 if at==CALLS+8 else 1)
            assert 0<=size<0x100000
            address=self.heap; self.heap += ((size+7)&~7)+64
            assert self.heap<0x63200000
            cpu.mem_write(address-16,b'\xa5'*(size+32));cpu.mem_write(address,bytes(size))
            self.allocations.append((address,size));result=address
        elif at==CALLS+4: result=0 # heap free; buffers kept to inspect guards
        elif at in (CALLS+16,CALLS+20,CALLS+24):
            width={CALLS+16:1,CALLS+20:2,CALLS+24:4}[at]
            count=cpu.reg_read(reg.UC_ARM_REG_R2)*width
            offset=cpu.reg_read(reg.UC_ARM_REG_R3)
            assert offset+count<=len(self.serial),(hex(at),offset,count,len(self.serial))
            self.serial[offset:offset+count]=cpu.mem_read(cpu.reg_read(reg.UC_ARM_REG_R1),count)
            self.writes.append((offset,count));result=1
        elif at==CALLS+28: result=0 # no output stream error
        if result is None: return super()._hook(cpu,at,size,user)
        cpu.reg_write(reg.UC_ARM_REG_R0,result)
        cpu.reg_write(reg.UC_ARM_REG_PC,cpu.reg_read(reg.UC_ARM_REG_LR))

    def entry(self,tag,kind=7,count=32):
        return self.call(0x535ce8b0,0x55357b7c,tag,kind,count,stack=struct.pack('<I',0))

    def create(self):
        self.uc.mem_write(WRITER,bytes(0x180));self.uc.mem_write(COMMON,bytes(0x900))
        put(self.uc,WRITER,0x53d30e38);put(self.uc,WRITER+8,COMMON)
        self.call(0x535cfa34,WRITER+0x44,0)
        # Existing sub-IFD entries are supplied by the enclosing writer. Keep
        # simple native entries here; creation never accesses their contents.
        put(self.uc,WRITER+0x174,self.entry(0x927c))
        put(self.uc,WRITER+0x170,self.entry(0xa005,4,1))
        self.call(0x53601240,WRITER)
        start,end=u32(self.uc,WRITER+0x50),u32(self.uc,WRITER+0x54)
        self.entries=[u32(self.uc,p) for p in range(start,end,4)]
        tags=[struct.unpack('<H',self.uc.mem_read(p+4,2))[0] for p in self.entries]
        assert tags==sorted(tags) and len(set(tags))==len(tags)
        assert tags.count(0x9286)==1
        self.comment=self.entries[tags.index(0x9286)]
        return tags

    def guards(self):
        for at,size in self.allocations:
            assert bytes(self.uc.mem_read(at-16,16))==b'\xa5'*16
            assert bytes(self.uc.mem_read(at+size,16))==b'\xa5'*16

    def write(self,tone,common=COMMON):
        put(self.uc,WRITER+8,common);self.uc.mem_write(common+0x77c,bytes([tone]))
        result=self.call(0x535ff9dc,WRITER,self.comment)
        assert result==1
        at=u32(self.uc,self.comment+16)
        value=bytes(self.uc.mem_read(at,192));self.guards()
        assert value[:8]==b'ASCII\0\0\0'
        return value

    def serialize(self, formatter=0):
        ifd=WRITER+0x44
        size=self.call(0x535cffd4,ifd)
        put(self.uc,ifd+0x2c,26) # TIFF header + single ExifIFDPointer in IFD0
        self.call(0x535cfd08,ifd) # layout out-of-line entry offsets
        self.serial=bytearray(size+26)
        # Explicit IFD0 encoding (tag, type LONG, count 1, Exif IFD offset).
        self.serial[:26]=b'II*\0'+struct.pack('<IH',8,1)+struct.pack('<HHII',0x8769,4,1,26)+bytes(4)
        assert self.call(0x535cfdb0,ifd,STREAM,formatter)==1
        return bytes(self.serial)

def verify(data,manifest,out=None):
    n=JpegProbe(data,manifest);tags=n.create();m=manifest['jpegMetadata']
    assert struct.unpack('<HHI',n.uc.mem_read(n.comment+4,8))==(0x9286,7,192)
    ifd=WRITER+0x44
    total=n.call(0x535cffd4,ifd)
    n.uc.mem_write(n.comment+0x14,b'\0');without=n.call(0x535cffd4,ifd)
    n.uc.mem_write(n.comment+0x14,b'\1');assert total-without==204
    expected={e['id']:e['text'] for e in m['entries']}
    rows=[]
    # Reuse the same writer/buffer; native transitions must erase stale film data.
    for tone in [64,11,72,65,22,66,67,68,69,70,71,64,255,0,72]:
        value=n.write(tone)
        text=value[8:].split(b'\0')[0].decode('ascii')
        assert text==expected.get(tone,m['nativeText'])
        assert value[8+len(text):]==bytes(192-8-len(text))
        rows.append(dict(tone=tone,text=text))
    # Separate captured CommonProperty objects; an unrelated live selection does
    # not influence either queued writer snapshot.
    n.uc.mem_write(OTHER,bytes(0x900)); n.uc.mem_write(COMMON+0x77c,b'\x40')
    assert n.write(72,OTHER)[8:].startswith(expected[72].encode())
    put(n.uc,WRITER+8,COMMON)
    assert n.call(0x535ff9dc,WRITER,n.comment)==1
    assert bytes(n.uc.mem_read(u32(n.uc,n.comment+16),192))[8:].startswith(expected[64].encode())
    # Existing JPEG-specific ComponentsConfiguration takes the original fallback.
    components=n.entries[tags.index(0x9101)]
    assert n.call(0x535ff9dc,WRITER,components)==1
    assert bytes(n.uc.mem_read(components+12,4)) in (b'\1\2\3\0',b'\4\5\6\0')
    tiff=n.serialize();n.guards()
    count=struct.unpack_from('<H',tiff,26)[0];assert count==len(tags)
    entries=[struct.unpack_from('<HHII',tiff,28+i*12) for i in range(count)]
    e=next(e for e in entries if e[0]==0x9286)
    assert e[1:3]==(7,192) and tiff[e[3]:e[3]+192][8:].startswith(expected[64].encode())
    # Exercise the actual IFD -> JPEG formatter -> Exif virtual dispatch during
    # serialization; no direct setter call supplies this test's comment bytes.
    for entry in n.entries:n.uc.mem_write(entry+0x14,bytes([int(entry==n.comment)]))
    n.uc.mem_write(u32(n.uc,n.comment+16),bytes(192));n.uc.mem_write(COMMON+0x77c,b'\x41')
    tiff=n.serialize(WRITER)
    e=struct.unpack_from('<HHII',tiff,28)
    assert e[:3]==(0x9286,7,192) and tiff[e[3]:e[3]+192][8:].startswith(expected[65].encode())
    for entry in n.entries:n.uc.mem_write(entry+0x14,b'\1')
    n.guards()
    if out:
        out.mkdir(parents=True,exist_ok=True)
        from PIL import Image
        b=io.BytesIO();Image.new('RGB',(16,16),(128,128,128)).save(b,format='JPEG')
        for row in rows:
            n.write(row['tone']);tiff=n.serialize();exif=b'Exif\0\0'+tiff
            jpg=b.getvalue(); fixture=jpg[:2]+b'\xff\xe1'+struct.pack('>H',len(exif)+2)+exif+jpg[2:]
            (out/f"native-fixture-{row['tone']}.jpg").write_bytes(fixture)
    return dict(passed=True,cases=len(rows)+6,creation_tags=len(tags),size_increase=204,
                native_factory_setter_ifd_size_layout_serializer=True,guarded_allocations=len(n.allocations),
                native_serializer_jpeg_formatter_dispatch=True,
                allocation_guards_passed=True,rows=rows,hardwareTested=False,
                scope=__doc__)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--rtos',type=Path,required=True)
    p.add_argument('--manifest',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();r=verify(a.rtos.read_bytes(),json.loads(a.manifest.read_text()),a.out)
    (a.out/'native-jpeg-report.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
