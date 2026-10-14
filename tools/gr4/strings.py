import sys,struct
from pathlib import Path
sys.path.insert(0,'tools/gr3x'); from disasm import mov_refs, disasm
old=Path('../inputs/rtos.bin').read_bytes(); new=Path('../inputs/gr4-rtos.bin').read_bytes(); BASE=0x53000000
for arg in sys.argv[1:]:
 a=int(arg,0); off=a-BASE; length=2048
 print('\nENTRY',hex(a))
 seen=set()
 for i in range(off,off+length,4):
  w=struct.unpack_from('<I',old,i)[0]
  if w&0x0ff00000!=0x03000000: continue
  for step in (4,8,12,16,20):
   h=struct.unpack_from('<I',old,i+step)[0]
   if h&0x0ff0f000!=(0x03400000|(w&0xf000)):continue
   ptr=(((h>>4&0xf000)|(h&0xfff))<<16)|((w>>4&0xf000)|(w&0xfff)); p=ptr-BASE
   if not 0<=p<len(old):continue
   s=old[p:old.find(b'\0',p)]
   if len(s)<8 or len(s)>400 or any(c<32 or c>126 for c in s) or s in seen:continue
   seen.add(s)
   if b'Image' not in s and b'Tone' not in s and b'Parameter' not in s and b'Gamma' not in s:continue
   found=new.find(s+b'\0'); targets=[BASE+found] if found>=0 else []
   refs=mov_refs(new,targets) if targets else {}
   print(hex(BASE+i),s.decode(),{hex(k):list(map(hex,v)) for k,v in refs.items()})
