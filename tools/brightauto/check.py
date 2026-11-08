# SPDX-License-Identifier: GPL-2.0-only
"""Replay the complete LCD Auto function, including its stock division helper.
Usage: python3 tools/brightauto/check.py 1.20 IMAGE.rtos stock|bright|balanced
Requires unicorn; inputs stay private. No device access.
"""
import argparse,bisect,json,random
from pathlib import Path
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_ARM,UC_PROT_READ,UC_PROT_EXEC,UC_PROT_ALL
from unicorn import arm_const as R
ap=argparse.ArgumentParser();ap.add_argument('version',choices=['1.11','1.20']);ap.add_argument('image',type=Path);ap.add_argument('mode',choices=['stock','bright','balanced']);a=ap.parse_args()
base=0x53000000;entry=0x5326811c if a.version=='1.11' else 0x53269f74
ys={'stock':[53,63,75,90,110,150,210,260,280,285,290,320,356,470,610,770,930,1050],
 'bright':[53,65,80,100,140,210,300,400,480,540,600,660,740,840,970,1130,1320,1500],
 'balanced':[53,64,78,96,128,185,265,345,400,435,465,550,660,815,970,1130,1320,1500]}[a.mode]
xs=[1<<k for k in range(18)]
def reference(x):
 if x<=1:return 53
 if x>=xs[-1]:return ys[-1]
 k=bisect.bisect_right(xs,x)-1
 return ys[k]+(ys[k+1]-ys[k])*(x-xs[k])//(xs[k+1]-xs[k])
b=a.image.read_bytes();u=Uc(UC_ARCH_ARM,UC_MODE_ARM);u.mem_map(base,(len(b)+4095)&~4095,UC_PROT_READ|UC_PROT_EXEC);u.mem_write(base,b)
stack=0x61000000;sp=stack+0x8000;stop=0x62000000
u.mem_map(stack,0x10000,UC_PROT_ALL);u.mem_map(stop,4096,UC_PROT_READ|UC_PROT_EXEC)
rng=random.Random(16);inputs=sorted(set(list(range(2049))+[max(0,x+d) for x in xs for d in [-1,0,1]]+[rng.randrange(1<<17) for _ in range(8000)]+[0xffffffff,0x80000000,1<<20]))
saved=[0xdead0000+k for k in range(8)];regs=[getattr(R,'UC_ARM_REG_R'+str(k)) for k in range(4,12)]
for x in inputs:
 u.reg_write(R.UC_ARM_REG_CPSR,0x13);u.reg_write(R.UC_ARM_REG_SP,sp);u.reg_write(R.UC_ARM_REG_LR,stop);u.reg_write(R.UC_ARM_REG_R0,0xabcdef00);u.reg_write(R.UC_ARM_REG_R1,x)
 for reg,v in zip(regs,saved):u.reg_write(reg,v)
 u.emu_start(entry,stop,count=10000)
 assert u.reg_read(R.UC_ARM_REG_PC)==stop,hex(u.reg_read(R.UC_ARM_REG_PC))
 actual=u.reg_read(R.UC_ARM_REG_R0);assert actual==reference(x),(x,actual,reference(x))
 assert [u.reg_read(reg) for reg in regs]==saved and u.reg_read(R.UC_ARM_REG_SP)==sp
print(json.dumps({'version':a.version,'mode':a.mode,'calls':len(inputs),'mismatches':0,'calleeSavedAndStackPreserved':True,'stockDivisionHelperExecuted':True}))
