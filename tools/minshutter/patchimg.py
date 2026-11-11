import struct, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sites import sites, CREATE
B = 0x53000000
def patched(R):
    R = bytearray(R)
    s, new = sites()
    for x in s:
        a = x['address'] - B
        got = struct.unpack_from('<I', R, a)[0]
        assert got == x['expected'], (hex(x['address']), hex(got), hex(x['expected']))
        struct.pack_into('<I', R, a, x['replacement'])
    # create: the original function is 0x531cfa20..0x531cfaac (35 words); the new body + nops
    a = CREATE - B
    orig = [struct.unpack_from('<I', R, a + 4 * i)[0] for i in range(35)]
    assert orig[0] == 0xe1a0c00d and orig[1] == 0xe92dd810 and orig[34] == 0xe89da810 and struct.unpack_from('<I', R, a + 35 * 4)[0] == 0xeb194166
    words = new + [0xe320f000] * (35 - len(new))
    for i, w in enumerate(words): struct.pack_into('<I', R, a + 4 * i, w)
    return bytes(R), [(CREATE + 4 * i, orig[i], words[i]) for i in range(35) if orig[i] != words[i]]
