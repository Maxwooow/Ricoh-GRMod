"""Small read-only A32 inspection helper. Addresses are explicit, never guessed."""
import argparse
import struct
from pathlib import Path
from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM

BASE = 0x53000000

def disasm(data, address, length):
    cs = Cs(CS_ARCH_ARM, CS_MODE_ARM)
    for at in range(address, address + length, 4):
        word = data[at - BASE:at - BASE + 4]
        rows = list(cs.disasm(word, at))
        if rows:
            i = rows[0]
            print(f'{at:08x} {word.hex()}  {i.mnemonic:8} {i.op_str}')
        else:
            print(f'{at:08x} {word.hex()}  .word')

def mov_refs(data, targets):
    result = {a: [] for a in targets}
    for offset in range(0, min(0xb00000, len(data)) - 16, 4):
        w = struct.unpack_from('<I', data, offset)[0]
        if w & 0x0ff00000 != 0x03000000:
            continue
        for step in (4, 8, 12):
            h = struct.unpack_from('<I', data, offset + step)[0]
            if h & 0x0ff0f000 != (0x03400000 | (w & 0xf000)):
                continue
            value = (((h >> 4 & 0xf000) | (h & 0xfff)) << 16) | ((w >> 4 & 0xf000) | (w & 0xfff))
            if value in result:
                result[value].append(BASE + offset)
    return result

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('rtos', type=Path)
    p.add_argument('addresses', nargs='+', type=lambda s: int(s, 0))
    p.add_argument('--length', type=lambda s: int(s, 0), default=256)
    p.add_argument('--refs', action='store_true')
    a = p.parse_args()
    data = a.rtos.read_bytes()
    if a.refs:
        for target, refs in mov_refs(data, a.addresses).items():
            print(hex(target), [hex(r) for r in refs])
    else:
        for at in a.addresses:
            disasm(data, at, a.length)
