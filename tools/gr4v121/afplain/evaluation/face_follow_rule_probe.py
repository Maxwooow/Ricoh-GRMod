#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
"""What the three faceFollow words change in the stock settings recompute.

  face_follow_rule_probe.py --rtos OFFICIAL_RTOS --fixture-dir tools/gr4v121/afplain/evaluation --repo . --output OUT.json [--patched BUILD_RTOS]

Runs the stock UserData recompute 532b44c0(U,2) (the one AF START also calls) for every raw focus
mode 0..15 x desired face setting 0..2, on the official RTOS and again with the three words of
core/src/fw/gr4v121/aspect/subjectaf.ts (faceWords at faceRule) written into it, and lists every difference in the effective face
setting, the eligibility getter, the Common AF kind and the property events the recompute emits.
Expected: exactly one cell changes, Follow (5) with the setting On (0): Off -> On, eligible 0 -> 1."""
import argparse,json,re,struct,sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--rtos',type=Path,required=True);p.add_argument('--fixture-dir',type=Path,required=True);p.add_argument('--repo',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--patched',type=Path);a=p.parse_args()
sys.path.insert(0,str(a.fixture_dir));import stock_fixture as sf
sf.configure(a.rtos,a.repo)
# The three words of core/src/fw/gr4v121/aspect/subjectaf.ts (faceWords at faceRule): cmp r0,#1 -> tst r0,#1; moveq r2,#0 -> movne; movne r2,#2 -> moveq.
patches=[(0x532ae470,0xe3500001,0xe3100001),(0x532ae474,0x03a02000,0x13a02000),(0x532ae478,0x13a02002,0x03a02002)]
if a.patched:   # the words as a build has them
 built=a.patched.read_bytes();assert all(struct.unpack_from('<I',built,at-0x53000000)[0]==after for at,_,after in patches),'the build does not have the three words'
def table(patched):
 f=sf.Fixture();rows=[]
 for address,before,after in patches:
  assert f.e.r32(address)==before
  if patched:f.e.mu.mem_write(address,struct.pack('<I',after))
 for mode in range(16):
  for setting in(0,1,2):
   f.reset(mode,0,0,False);f.e.wb(sf.U+0xe8,bytes([setting]));f.e.wb(sf.U+0xc2c,b'\2');f.call(0x532b4d10,sf.U,2);s=f.snapshot()
   rows.append(dict(mode=mode,setting=setting,effective=s['faceSettingRaw'],eligible=s['eligible'],getter=f.call(0x532a294c,sf.U),kind=f.call(0x532a1f28,mode),events=f.events))
 return rows
stock,new=table(False),table(True);key=lambda r:(r['effective'],r['eligible'],r['getter'],r['kind'])
changed=[dict(mode=x['mode'],setting=x['setting'],stock=key(x),patched=key(y),eventsDiffer=x['events']!=y['events'])for x,y in zip(stock,new)if key(x)!=key(y)or x['events']!=y['events']]
ok=len(changed)==1 and changed[0]['mode']==5 and changed[0]['setting']==0 and changed[0]['stock'][:2]==(2,0)and changed[0]['patched'][:2]==(0,1)
a.output.write_text(json.dumps(dict(ok=ok,cases=len(stock),changed=changed,patches=[[hex(v)for v in q]for q in patches]),indent=1)+'\n');print(json.dumps(dict(ok=ok,cases=len(stock),changed=changed)))
sys.exit(0 if ok else 1)
