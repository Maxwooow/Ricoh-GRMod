import sys,struct
from pathlib import Path
b=Path('../inputs/gr4-rtos.bin').read_bytes();B=0x53000000
targets={int(a,0):[] for a in sys.argv[1:]}
for o in range(0,0xb00000,4):
 w=struct.unpack_from('<I',b,o)[0]
 if w&0x0e000000==0x0a000000:
  d=w&0xffffff;d=d-0x1000000 if d&0x800000 else d;t=B+o+8+d*4
  if t in targets:targets[t].append(hex(B+o))
for t,r in targets.items():print(hex(t),r)
