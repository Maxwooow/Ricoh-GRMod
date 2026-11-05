"""Execute IIIx's native clarity table copy and row addressing, not its ISP.
Checks the independently located consumer of the 198-byte gain table.
"""
import argparse, json, struct
from pathlib import Path
from unicorn import arm_const as reg
from native_probe import NativeProbe, OBJECT, OUTPUT, STACK, STOP

TABLE = 0x538f1fd4

def verify(data, edits=()):
    p = NativeProbe(data)
    expected = bytearray(data[TABLE-0x53000000:TABLE-0x53000000+198])
    gains={'weak':[820,740,700,700,740,840,940,1024,1024,1024,1024],
           'medium':[680,560,500,500,540,680,860,960,1024,1024,1024],
           'strong':[540,400,330,330,380,540,760,920,1024,1024,1024]}
    for e in edits:
        assert e['level'] in (-4,-3,-2,-1)
        struct.pack_into('<11h',expected,(e['level']+4)*22,*gains[e['strength']])
    p.uc.mem_write(TABLE, bytes(expected))
    rows = []
    for level in (-4,-3,-2,-1,1,2,3,4):
        p.uc.reg_write(reg.UC_ARM_REG_CPSR, 0x13)
        p.uc.reg_write(reg.UC_ARM_REG_SP, STACK)
        p.uc.reg_write(reg.UC_ARM_REG_LR, STOP)
        p.uc.reg_write(reg.UC_ARM_REG_R0, OBJECT)
        p.uc.reg_write(reg.UC_ARM_REG_R1, OUTPUT)
        p.uc.reg_write(reg.UC_ARM_REG_R2, OUTPUT+0x100)
        p.uc.reg_write(reg.UC_ARM_REG_R3, level & 0xffffffff)
        p.uc.mem_write(STACK-0x1000, bytes(0x2000))
        p.uc.emu_start(0x5367c158, 0x5367c1ac, timeout=2_000_000, count=10000)
        assert p.uc.reg_read(reg.UC_ARM_REG_PC) == 0x5367c1ac
        fp = p.uc.reg_read(reg.UC_ARM_REG_FP)
        assert bytes(p.uc.mem_read(fp-0xf8, 198)) == expected
        p.uc.emu_start(0x5367c1ac, 0x5367c1b4, timeout=2_000_000, count=10)
        assert p.uc.reg_read(reg.UC_ARM_REG_R8) == level+4
        # Skip the hardware pyramid setup; exercise its unchanged row-address
        # instructions with the actual copied table and level from above.
        p.uc.emu_start(0x5367c7dc, 0x5367c7e8, timeout=2_000_000, count=10)
        address = p.uc.reg_read(reg.UC_ARM_REG_R8)
        assert address == fp-0xf8+(level+4)*22
        gain = list(struct.unpack('<11h', p.uc.mem_read(address,22)))
        rows.append({'level':level,'gains':gain})
    return {'table':hex(TABLE),'native_copy_and_selection_cases':len(rows),'calls':len(rows),
            'rows':rows,'hardware_tested':False,
            'scope':'Native table copy and row selection; clarity rendering, SR and camera capture are not emulated.'}

if __name__ == '__main__':
    ap=argparse.ArgumentParser();ap.add_argument('rtos',type=Path);a=ap.parse_args()
    print(json.dumps(verify(a.rtos.read_bytes()),indent=2))
