import sys,struct,re,json
from pathlib import Path
sys.path.insert(0,'tools/gr3x'); from disasm import mov_refs
B=0x53000000
old=Path('../inputs/rtos.bin').read_bytes(); new=Path('../inputs/gr4-rtos.bin').read_bytes()
def strings(d,start,end):
 out=[]
 for i in range(start-B,end-B,4):
  w=struct.unpack_from('<I',d,i)[0]
  if w&0x0ff00000!=0x03000000 or w>>12&15!=3:continue
  for step in (4,8,12,16,20):
   h=struct.unpack_from('<I',d,i+step)[0]
   if h&0x0ff0f000!=(0x03400000|(w&0xf000)):continue
   p=(((h>>4&0xf000)|(h&0xfff))<<16)|((w>>4&0xf000)|(w&0xfff)); p-=B
   if 0<=p<len(d):
    s=d[p:d.find(b'\0',p)]
    if 7<len(s)<120 and all(32<=c<127 for c in s):out.append(s)
 return list(dict.fromkeys(out))
starts=[int(a,0) for a in sys.argv[1:]]
if not starts: starts=[int(a,16) for a in re.findall(r'\[(0x[0-9a-f]+), 0x7',Path('core/src/fw/gr3x/image-control.ts').read_text())]
result={}
for at in starts:
 ss=strings(old,at,at+600)
 for s in ss:
  found=new.find(s+b'\0')
  if found<0:continue
  refs=mov_refs(new,[B+found])[B+found]
  starts2=[]
  for r in refs:
   pro=new.rfind(bytes.fromhex('0dc0a0e1'),max(0,r-B-4000),r-B+4)
   starts2.append(hex(B+pro))
  print(hex(at),s.decode(),starts2)
  result[hex(at)]={'symbol':s.decode(),'starts':starts2,'refs':list(map(hex,refs))}
Path('research/gr4-film9/symbol-candidates.json').write_text(json.dumps(result,indent=2))
