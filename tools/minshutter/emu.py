"""Run the camera's own Minimum Shutter Speed list code (official and patched) with the list widget,
property and settings services substituted, and compare."""
import struct, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_UNMAPPED
from unicorn import arm_const as A
B = 0x53000000; RAMVA, RAMSRC, RAMLEN = 0x55000000, 0x5407b640, 0x3a0c0
STACK, STOP = 0x61000000, 0x60000000
OBJ, LIST, ROWS, PROP, BUF = 0x62000000, 0x62010000, 0x62020000, 0x62030000, 0x62040000
class Cam:
    def __init__(s, R):
        c = s.c = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        size = (len(R) + 0xfff) & ~0xfff
        c.mem_map(B, size); c.mem_write(B, bytes(R))
        c.mem_map(RAMVA, 0x200000); c.mem_write(RAMVA, bytes(R[RAMSRC - B:RAMSRC - B + RAMLEN]))
        c.mem_map(STOP & ~0xfff, 0x1000)
        c.mem_map(STACK - 0x100000, 0x101000)
        c.mem_map(0x62000000, 0x100000)
        # VFP on
        c.reg_write(A.UC_ARM_REG_C1_C0_2, c.reg_read(A.UC_ARM_REG_C1_C0_2) | (0xf << 20))
        c.reg_write(A.UC_ARM_REG_FPEXC, 0x40000000)
        s.stubs = {}; s.log = []
        c.hook_add(UC_HOOK_CODE, s._hook)
        c.mem_write(OBJ + 0x160, struct.pack('<I', LIST))
    def stub(s, at, fn): s.stubs[at] = fn
    def _hook(s, c, at, size, ud):
        f = s.stubs.get(at)
        if f is None: return
        r = f(c)
        if r is not None: c.reg_write(A.UC_ARM_REG_R0, r & 0xffffffff)
        c.reg_write(A.UC_ARM_REG_PC, c.reg_read(A.UC_ARM_REG_LR))
    def reg(s, n): return s.c.reg_read(getattr(A, 'UC_ARM_REG_' + n))
    def call(s, at, *args, s0=None):
        c = s.c
        for i, v in enumerate(args): c.reg_write(getattr(A, f'UC_ARM_REG_R{i}'), v)
        if s0 is not None: c.reg_write(A.UC_ARM_REG_S0, struct.unpack('<I', struct.pack('<f', s0))[0])
        saved = [0x4440 + i for i in range(4, 12)]
        for i, v in zip(range(4, 12), saved): c.reg_write(getattr(A, f'UC_ARM_REG_R{i}'), v)
        c.reg_write(A.UC_ARM_REG_SP, STACK); c.reg_write(A.UC_ARM_REG_LR, STOP)
        c.emu_start(at, STOP, count=2_000_000)
        assert c.reg_read(A.UC_ARM_REG_PC) == STOP, hex(c.reg_read(A.UC_ARM_REG_PC))
        assert c.reg_read(A.UC_ARM_REG_SP) == STACK, 'stack'
        assert [s.reg(f'R{i}') for i in range(4, 12)] == saved, 'callee-saved'
        return c.reg_read(A.UC_ARM_REG_R0)
    def s0(s): return struct.unpack('<f', struct.pack('<I', s.c.reg_read(A.UC_ARM_REG_S0)))[0]
    def mem(s, a, n): return bytes(s.c.mem_read(a, n))
    def cstr(s, a): return s.mem(a, 32).split(b'\0')[0].decode()

def fwd(cam, num, den):
    """The camera's (num, den) -> Tv (0x536c0848 with the third-stop flag the camera has)."""
    flag = cam.mem(0x53d62cb4, 1)[0]
    cam.call(0x536c0848, 0, num, den, flag); return cam.s0()
def inv(cam, tv):
    flag = cam.mem(0x53d62cb4, 1)[0]
    cam.c.mem_write(BUF, bytes(8))
    cam.call(0x536c0780, 0, BUF, BUF + 2, flag, s0=tv)
    return struct.unpack('<HH', cam.mem(BUF, 4))

def run_list(R):
    """Everything the list does, through the camera's own functions."""
    cam = Cam(R); out = {}
    # create: capture the row types and count given to the list widget
    seen = {}
    def create(c):
        cnt = c.reg_read(A.UC_ARM_REG_R2)
        seen['args'] = (c.reg_read(A.UC_ARM_REG_R0), cnt, c.reg_read(A.UC_ARM_REG_R3))
        seen['types'] = bytes(c.mem_read(c.reg_read(A.UC_ARM_REG_R1), cnt))
    cam.stub(0x53394700, create)
    cam.call(0x531cfa20, OBJ)
    out['create'] = (seen['args'], seen['types'])
    # rows: the label of each row (row object = ROWS + i), the camera's own formatter
    rows = {}
    cam.stub(0x53394848, lambda c: ROWS + 0x10 * c.reg_read(A.UC_ARM_REG_R1))
    cam.stub(0x5320ae60, lambda c: PROP)
    cam.stub(0x5320b754, lambda c: PROP)
    def label(c):
        rows[(c.reg_read(A.UC_ARM_REG_R0) - ROWS) // 0x10] = cam.cstr(c.reg_read(A.UC_ARM_REG_R1))
    cam.stub(0x5339e8cc, label)
    cam.call(0x531cfab0, OBJ)
    out['labels'] = [rows[i] for i in sorted(rows)]
    n = len(out['labels'])
    # set: each index -> the Tv given to the setting (0x53242840)
    tvs = []
    cur = {'i': 0}
    cam.stub(0x53394910, lambda c: cur['i'])
    cam.stub(0x5320b3f4, lambda c: PROP)
    cam.stub(0x536c02d0, lambda c: 0)
    cam.stub(0x53242840, lambda c: tvs.append(cam.s0()))
    for i in range(n):
        cur['i'] = i; cam.call(0x531cf880, OBJ)
    out['tv'] = tvs
    # current: each Tv -> rows marked and the cursor
    marks = []
    for i, tv in enumerate(tvs + [7.5, -6.0]):
        on, cursor = [], []
        cam.stub(0x5324417c, lambda c, tv=tv: c.reg_write(A.UC_ARM_REG_S0, struct.unpack('<I', struct.pack('<f', tv))[0]))
        cam.stub(0x5339e828, lambda c: on.append(((c.reg_read(A.UC_ARM_REG_R0) - ROWS) // 0x10, c.reg_read(A.UC_ARM_REG_R1))))
        cam.stub(0x53395520, lambda c: cursor.append(c.reg_read(A.UC_ARM_REG_R1)))
        cam.call(0x531cfb40, OBJ)
        marks.append((sorted(k for k, v in on if v == 1), len(on), cursor))
    out['marks'] = marks
    # keys: Down (0x531cf7e8) held (repeat) at each index: moves unless at the last
    moves = []
    for i in range(n):
        mv = []
        cam.stub(0x53395350, lambda c: mv.append((c.reg_read(A.UC_ARM_REG_R1), c.reg_read(A.UC_ARM_REG_R2))))
        cur['i'] = i
        cam.c.mem_write(BUF + 0x10, struct.pack('<II', 0, 1)); cam.c.mem_write(BUF + 0x20, struct.pack('<I', BUF + 0x10))
        cam.c.mem_write(BUF + 0x30, struct.pack('<II', 0, BUF + 0x10 - 4 + 4))
        # r1 -> event; [r1+4] -> key info; [[r1+4]+4] = repeat flag
        cam.c.mem_write(BUF + 0x40, struct.pack('<II', 0, BUF + 0x50)); cam.c.mem_write(BUF + 0x50, struct.pack('<II', 0, 1))
        cam.call(0x531cf7e8, OBJ, BUF + 0x40)
        moves.append(mv)
    out['downHeld'] = moves
    out['fwdinv'] = None
    return cam, out
