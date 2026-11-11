import sys, os, struct, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from patchimg import patched
from emu import run_list
off, L, G = 0x10870, 17520384, 24576
D0 = open(os.environ.get('OFFICIAL_DECODED', '../fw/decoded.bin'), 'rb').read()
D1 = open(os.environ.get('BUILT_DECODED', 'out/decoded.bin'), 'rb').read()
print('decoded sha', hashlib.sha256(D1).hexdigest())
assert len(D1) == len(D0) + G
R0 = D0[off:off + L]; R1 = D1[off:off + L]
P, _ = patched(R0)
assert R1 == P, 'RTOS differs from the planned patch'
# everything before RTOS, except the RTOS length word, identical; everything after the growth identical (shifted)
assert D1[:off - 4] == D0[:off - 4]
assert struct.unpack_from('<I', D1, off - 4)[0] == struct.unpack_from('<I', D0, off - 4)[0] + G
assert D1[off + L + G:] == D0[off + L:]
tail = D1[off + L:off + L + G]
print('growth record', tail.rstrip(b'\0')[:60], 'nonzero bytes', sum(1 for b in tail if b))
assert sum(struct.unpack('<%dI' % (len(D1) // 4), D1)) & 0xffffffff == 0
diff = [a for a in range(0, L, 4) if R0[a:a + 4] != R1[a:a + 4]]
print('changed RTOS words', len(diff), 'from', hex(0x53000000 + diff[0]), 'to', hex(0x53000000 + diff[-1]))
assert all(0x531cf824 <= 0x53000000 + a <= 0x531cfc1c for a in diff)
camO, o = run_list(R0); camP, p = run_list(R1)
n = len(p['labels']); assert n == 46 and len(o['labels']) == 31
assert p['create'][0][1:] == (46, 58) and p['create'][1] == bytes([0x15]) * 46 and o['create'][0][1:] == (31, 58) and o['create'][1] == bytes([0x15]) * 31
assert p['labels'][:31] == o['labels'] and p['tv'][:31] == o['tv']
assert p['labels'][31:] == ['1.3"', '1.6"', '2"', '2.5"', '3"', '4"', '5"', '6"', '8"', '10"', '13"', '15"', '20"', '25"', '30"']
assert all(abs(p['tv'][31 + k] - (-(k + 1) / 3)) < 1e-4 for k in range(15))
for i in range(n): assert p['marks'][i] == ([i], 46, [i]), (i, p['marks'][i])
for i in range(31): assert o['marks'][i] == ([i], 31, [i])
assert p['marks'][46] == ([o['marks'][31][0][0]], 46, o['marks'][31][2]) and p['marks'][47] == ([], 46, [])
assert all(m == [(1, 1)] for m in p['downHeld'][:45]) and p['downHeld'][45] == []
assert o['downHeld'][:30] == p['downHeld'][:30] and o['downHeld'][30] == []
print('all checks passed: 46 values, the first 31 as the official list (labels, Tv set, marking), 15 new from 1.3" to 30" (Tv -1/3 .. -5)')
