"""Read-only A32 cross-version candidate locator. Candidates require manual review."""
import sys, struct, json
from pathlib import Path
import numpy as np
BASE=0x53000000
old=Path('../inputs/rtos.bin').read_bytes(); new=Path('../inputs/gr4-rtos.bin').read_bytes()
def norm(a):
 a=a.copy(); branch=(a&0x0e000000)==0x0a000000; a[branch]&=0xff000000
 mov=((a&0x0ff00000)==0x03000000)|((a&0x0ff00000)==0x03400000); a[mov]&=0xfff0f000
 return a
x=norm(np.frombuffer(old[:0x980000],dtype='<u4')); y=norm(np.frombuffer(new[:0xb00000],dtype='<u4'))
for t in sys.argv[1:]:
 at=int(t,0); i=(at-BASE)//4; n=32; v=x[i:i+n]; scores=np.zeros(len(y)-n,dtype=np.uint16)
 for j,w in enumerate(v): scores+=(y[j:j+len(scores)]==w)
 best=np.argpartition(scores,-3)[-3:]; best=sorted(best,key=lambda b:-int(scores[b]))
 print(hex(at),[(hex(BASE+int(b)*4),int(scores[b])) for b in best])
