# SPDX-License-Identifier: GPL-2.0-only
"""Emulator harness for the multi-frame NR test build (unicorn; run outside the sandbox).

The camera's own code runs on the paths the two hooks touch, stock (the base build) and patched side by side:
  - back end: a real BEStillRecipe (constructor 0x53734828, stopped once its ShootingInfo pointer is set, as
    tools/gr4v120/aftierdiag/evidence/entry/p-provenance/probe_still_args.py), then the stock dispatch fragment of
    ExecuteProcessModule from 0x53745684 (add sb; bl SetupModuleConfig = our stub in the patched image; GetModuleConfig;
    GetModuleReturnConfig) up to the post into the module's mailbox 0x53904F3C;
  - front end: the per-frame decision of continuous drive 0x5367F838 (with our stub at 0x5367F904), and the
    end-of-frame step 0x5367FA00 that picks the next plan.
Replaced by Python (blind spots): the application's event queue getter 0x53240818 (a fixed fake queue) and its post
0x5325E2D8 (recorded in Cam.app_posts with the module's busy word at that moment; the real post locks a mutex, writes a ring and
sets the UI task's event flag), operator new/delete, the timer tick (27 MHz down-counter; the stock elapsed-time
function runs), ImageBufferAllocator (Alloc / Free / FreeMemorySize), the cache functions, the file service, the plan
starter of 0x5367FA00, assert/log, and the six constructor dependencies of the probe (the module's probe readings of the
tick, through its trampoline, do not move the emulated clock); the module's task and semaphore
kernel calls (class Kernel: its worker tasks take turns on the one emulated CPU, so no real concurrency).
"""
import hashlib, os, struct, sys
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_UNMAPPED, UC_HOOK_INTR, UC_HOOK_BLOCK
from unicorn.arm_const import *

BASE = 0x53000000
RAM_SRC, RAM_DST, RAM_LEN = 0x543B3100, 0x55000000, 0x58500
OBJ, HEAP, IMG, POOL, FAKE, STACK_TOP = 0x60000000, 0x62000000, 0xC0000000, 0x90000000, 0xF0000000, 0x7E100000
SENTINEL = 0x7E000010
REC_POOL_PAGE = 0x5C000000      # the camera's CAPTURERECIPE pool (0x5C000028 + k * 0x4968); mapped zero
CUR = 0x550832A8
SWITCH = CUR + 4 + 0x9AE
SLOT = 0x55839280              # the module's state word (handnight.ts; a build's own is its ctx word 1: Cam.slot)
REGS = [UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6, UC_ARM_REG_R7,
        UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11, UC_ARM_REG_R12]

OP_NEW, OP_DELETE = 0x539084BC, 0x539084F8
OP_NEW_A, OP_DELETE_A = 0x53908530, 0x5390856C   # new[] / delete[]
TICK = 0x5391CA64
IMG_OBJ, IMG_ALLOC, IMG_FREE, IMG_SIZE = 0x538F6604, 0x538F6A28, 0x538F666C, 0x538F677C
# Free 0x538F666C tail-calls the variable pool's free method 0x53905DB0 (pool, ptr, flag; lr = Free's caller).  Here Free goes
# there with r0 = a stand-in pool object; the method's first instruction runs (the base build's `mov ip, sp`, or the test
# build's hook), its body from 0x53905DB4 is the harness's allocator (blind spot: the pool and tk_rel_mpl)
POOL_FREE, POOL_FREE_BODY = 0x53905DB0, 0x53905DB4
CACHE_OBJ, FLUSH, DISCARD = 0x53918010, 0x539180A0, 0x5391808C
FILE_HOLDER = 0x537CF950
TIMER_HOLDER = 0x53919D68
ASSERT = 0x539154F8
LOCK, UNLOCK = 0x53907930, 0x53907A84   # mutex lock / unlock: answered 0 (blind spot)
APP_QUEUE, APP_POST = 0x53240818, 0x5325E2D8
FE_POST, START_LV = 0x53643344, 0x536520E0   # the front end's post (live-view restart, log version 10); StartLiveView (tests only)
LV_RESTART = 0x67C40802
APP_Q = 0x55088534            # the queue object the getter returns on the camera (fixed singleton)
CTOR_DEPS = (0x538A067C, 0x538A0E68, 0x5389FD0C, 0x53738E70, 0x5389E858, 0x538E40F8)


def f32(x): return struct.unpack('<I', struct.pack('<f', x))[0]


# ---- SMP T-Kernel tasks and semaphores for the module's merge workers ---------------------------------------------------
# The camera runs the workers on other cores; unicorn has one CPU.  Here every task (the caller = task 0, and each task the
# module creates) has its own register set (r0-r12, sp, lr, pc, cpsr, d0-d31, fpscr) and its own stack, and they take
# turns on the one emulated CPU: a task that waits on an unavailable semaphore or exits gives the CPU to the next ready
# task, and while tasks exist the CPU also switches to the next ready task every `slice` instructions (slice lengths
# vary, seeded), so jobs interleave at arbitrary instructions.  Kernel calls from the module only (the caller's return
# address in the module's code); the stock code's kernel calls go on to the svc hook as before.  What this does not show:
# real concurrency (two cores at the same instant, caches, memory bandwidth), the kernel's real scheduler and priorities,
# their effect on the stock tasks.
KSTUBS = {0x530681B0: 'rot_rdq', 0x5306764C: 'cre_tsk', 0x530683F0: 'sta_tsk', 0x53067AA8: 'exd_tsk', 0x53067820: 'del_tsk', 0x53067628: 'cre_sem',
          0x530682F4: 'sig_sem', 0x530684EC: 'wai_sem', 0x530677FC: 'del_sem'}
E_OK, E_NOMEM, E_ID, E_OBJ, E_NOEXS, E_DLT, E_TMOUT = 0, -0x210000, -0x120000, -0x290000, -0x2A0000, -0x330000, -0x320000
TSTACKS, TSTACK_SPAN, TTRAP = 0x7D000000, 0x10000, 0x7D0FFF00      # one 64 KB region per task (the task's own stack size is checked)
CTX_REGS = REGS + [UC_ARM_REG_SP, UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_CPSR, UC_ARM_REG_FPSCR] + [globals()['UC_ARM_REG_D%d' % i] for i in range(32)]


class Kernel:
    """mixed into Cam"""
    def kernel_init(self, slice_=20000, seed=1):
        import random
        self.mu.mem_map(TSTACKS, 0x100000)
        self.mu.mem_write(TTRAP, struct.pack('<I', 0xE320F000))
        def trap(uc, *_): raise RuntimeError('a worker task returned from its entry function')
        self.mu.hook_add(UC_HOOK_CODE, trap, begin=TTRAP, end=TTRAP)
        for a in KSTUBS: self.mu.hook_add(UC_HOOK_CODE, self._native, begin=a, end=a)
        self.tasks = {}; self.sems = {}; self.cur = 0; self.ready = []; self.klog = []; self.kfail = {}; self.kcalls = {}
        self.next_tid = 0x41; self.next_sem = 0x21; self.slice = slice_; self.krng = random.Random(seed); self.switches = 0
        self.preempts = 0; self.mod_range = self._module_range(); self.max_task_stack = 0; self._halted = False; self._resched = False
        # the module's probe clock readings (log version 8) go through a one-word trampoline `b 0x5391CA64` named in its ctx:
        # they return the emulated clock without moving it (so the probes do not change the emulated timing of the merge)
        self.probe_tramp = self._probe_trampoline(); self._probe_task = None; self.probe_reads = 0
        self.task_weight = {}; self.rotations = 0; self.insns = 0; self.insn_clock = False
        if self.probe_tramp:
            def tramp(uc, *_): self._probe_task = self.cur
            self.mu.hook_add(UC_HOOK_CODE, tramp, begin=self.probe_tramp, end=self.probe_tramp)
        orig = self.mu.emu_stop
        def stop():
            self._halted = True; orig()
        self._emu_stop = orig
        self.mu.emu_stop = stop

    def _probe_trampoline(self):
        """the ctx (movw/movt r0 in the BE stub) word that points to `b 0x5391CA64`"""
        w = struct.unpack_from('<I', self.rt, 0x53745688 - BASE)[0]
        if w >> 24 != 0xEB: return None
        stub = (0x53745688 + 8 + ((((w & 0xFFFFFF) ^ 0x800000) - 0x800000) << 2)) & 0xFFFFFFFF
        rd = lambda a: struct.unpack_from('<I', self.rt, a - BASE)[0] if BASE <= a < BASE + len(self.rt) - 3 else 0
        lo = hi = None
        for i in range(12):
            x = rd(stub + 4 * i)
            if (x & 0x0FF0F000) == 0x03000000: lo = ((x >> 4) & 0xF000) | (x & 0xFFF)
            if (x & 0x0FF0F000) == 0x03400000 and lo is not None: hi = ((x >> 4) & 0xF000) | (x & 0xFFF); break
        if hi is None: return None
        ctx = (hi << 16) | lo
        self.ctx_addr = ctx
        for i in range(80):
            t = rd(ctx + 4 * i)
            x = rd(t)
            if x >> 24 == 0xEA and (t + 8 + ((((x & 0xFFFFFF) ^ 0x800000) - 0x800000) << 2)) & 0xFFFFFFFF == TICK: return t
        return None

    def _module_range(self):
        """the module's code: the BE hook 0x53745688 branches to the stub, whose second bl is the module's entry"""
        w = struct.unpack_from('<I', self.rt, 0x53745688 - BASE)[0]
        if w >> 24 != 0xEB: return None
        stub = (0x53745688 + 8 + ((((w & 0xFFFFFF) ^ 0x800000) - 0x800000) << 2)) & 0xFFFFFFFF
        bls = []
        for i in range(12):
            a = stub + 4 * i
            if a - BASE + 4 > len(self.rt): break
            x = struct.unpack_from('<I', self.rt, a - BASE)[0]
            if x >> 24 == 0xEB: bls.append((a + 8 + ((((x & 0xFFFFFF) ^ 0x800000) - 0x800000) << 2)) & 0xFFFFFFFF)
        return (bls[1], bls[1] + 0x40000) if len(bls) >= 2 else None

    # -- contexts
    def _save(self):
        return [self.mu.reg_read(r) for r in CTX_REGS]

    def _load(self, regs):
        for r, v in zip(CTX_REGS, regs):
            if r != UC_ARM_REG_PC: self.mu.reg_write(r, v)
        self.mu.reg_write(UC_ARM_REG_PC, regs[CTX_REGS.index(UC_ARM_REG_PC)])

    def live(self):
        return [t for t in self.tasks.values() if t['state'] in ('ready', 'wait', 'run')]

    def _switch(self, keep):
        """give the CPU to the next ready task; keep: the current task's saved context (None: it has exited / blocked with
        its context already saved)"""
        me = self.cur
        if keep is not None:
            self._ctx_of(me)['regs'] = keep
            self.ready.append(me)
        if not self.ready: raise RuntimeError(f'deadlock: task {me:#x} waits and no task is ready ({self.klog[-6:]})')
        nxt = self.ready.pop(0)
        self.cur = nxt
        self.switches += 1
        if nxt: self.tasks[nxt]['state'] = 'run'
        self._load(self._ctx_of(nxt)['regs'])

    def _ctx_of(self, tid):
        if tid == 0:
            if not hasattr(self, '_master'): self._master = dict(regs=None)
            return self._master
        return self.tasks[tid]

    def _returning(self, value):
        """the current task's context as it continues after the call with r0 = value"""
        regs = self._save()
        regs[0] = value & 0xFFFFFFFF
        regs[CTX_REGS.index(UC_ARM_REG_PC)] = self.mu.reg_read(UC_ARM_REG_LR)
        return regs

    def _fail(self, name):
        n = self.kcalls[name] = self.kcalls.get(name, 0) + 1
        return n in self.kfail.get(name, ())

    def _kernel(self, name, r):
        lr = self.mu.reg_read(UC_ARM_REG_LR)
        if not self.mod_range or not (self.mod_range[0] <= lr < self.mod_range[1]): return None     # stock: the svc as before
        res = None
        if name == 'cre_tsk':
            exinf, atr, entry, pri, stksz, sstksz = struct.unpack('<6I', self.rb(r[0], 24)); assprc = self.r32(r[0] + 0x2C)
            if self._fail(name): res = E_NOMEM
            else:
                tid = self.next_tid; self.next_tid += 1
                lo = TSTACKS + (len(self.tasks) % 15) * TSTACK_SPAN
                self.wb(lo, b'\xcd' * TSTACK_SPAN)
                self.tasks[tid] = dict(tid=tid, state='dormant', entry=entry, exinf=exinf, atr=atr, pri=pri, stksz=stksz, sstksz=sstksz,
                                       assprc=assprc, lo=lo, hi=lo + TSTACK_SPAN, regs=None, depth=0)
                res = tid
        elif name == 'sta_tsk':
            t = self.tasks.get(r[0])
            if self._fail(name): res = E_OBJ
            elif not t or t['state'] != 'dormant': res = E_OBJ if t else E_NOEXS
            else:
                regs = self._save()
                regs[:13] = [0] * 13; regs[0] = r[1]; regs[1] = t['exinf']
                regs[CTX_REGS.index(UC_ARM_REG_SP)] = t['hi'] - 16
                regs[CTX_REGS.index(UC_ARM_REG_LR)] = TTRAP; regs[CTX_REGS.index(UC_ARM_REG_PC)] = t['entry']
                for i in range(32): regs[CTX_REGS.index(globals()['UC_ARM_REG_D%d' % i])] = 0
                t['regs'] = regs; t['state'] = 'ready'; self.ready.append(t['tid'])
                res = E_OK
                if not self._resched: self._resched = True; self._emu_stop()          # from now on: time slices
        elif name == 'del_tsk':
            t = self.tasks.get(r[0])
            res = E_NOEXS if not t else (E_OBJ if t['state'] != 'dormant' else E_OK)
            if res == E_OK: t['state'] = 'deleted'
        elif name == 'exd_tsk':
            t = self.tasks[self.cur]
            b = self.rb(t['lo'], TSTACK_SPAN); i = 0
            while i < len(b) and b[i] == 0xCD: i += 1
            t['depth'] = TSTACK_SPAN - 16 - i; self.max_task_stack = max(self.max_task_stack, t['depth'])
            t['state'] = 'gone'
            self.klog.append((self.cur, name, (), None))
            self._switch(None)
            return True
        elif name == 'cre_sem':
            isem, maxsem = self.r32(r[0] + 8), self.r32(r[0] + 0xC)
            if self._fail(name): res = E_NOMEM
            else:
                sid = self.next_sem; self.next_sem += 1
                self.sems[sid] = dict(count=isem, max=maxsem, waiters=[], live=True); res = sid
        elif name == 'sig_sem':
            s = self.sems.get(r[0])
            if self._fail(name): res = E_OBJ
            elif not s or not s['live']: res = E_NOEXS
            else:
                s['count'] += r[1]; res = E_OK
                while s['waiters'] and s['count'] >= s['waiters'][0][1]:
                    tid, cnt = s['waiters'].pop(0); s['count'] -= cnt
                    c = self._ctx_of(tid); c['regs'][0] = E_OK
                    if tid: self.tasks[tid]['state'] = 'ready'
                    self.ready.append(tid)
        elif name == 'wai_sem':
            s = self.sems.get(r[0])
            if self._fail(name): res = E_OBJ
            elif not s or not s['live']: res = E_NOEXS
            elif s['count'] >= r[1]: s['count'] -= r[1]; res = E_OK
            elif r[2] != 0xFFFFFFFF and not self.ready:
                # mf23 (LOG_DEFER's sleep): a timed wait nobody can end here: the time passes (the clock moves by the timeout), E_TMOUT;
                # a test may change memory meanwhile (on_wait(ms), as the other tasks would)
                self.klog.append((self.cur, name, (r[0], r[1], r[2]), 'timeout'))
                self.clock = (self.clock - r[2] * 27000) & 0xFFFFFFFF
                cb = getattr(self, 'on_wait', None)
                if cb: cb(r[2])
                res = E_TMOUT
            else:
                self.klog.append((self.cur, name, (r[0], r[1]), 'wait'))
                me = self.cur
                self._ctx_of(me)['regs'] = self._returning(0)
                if me: self.tasks[me]['state'] = 'wait'
                s['waiters'].append((me, r[1]))
                self._switch(None)
                return True
        elif name == 'rot_rdq':                  # the next ready task gets the CPU (any priority: one priority here)
            self.rotations += 1
            if self.ready:
                me = self.cur
                self._ctx_of(me)['regs'] = self._returning(E_OK)
                if me: self.tasks[me]['state'] = 'ready'
                self.ready.append(me)
                nxt = self.ready.pop(0); self.cur = nxt
                if nxt: self.tasks[nxt]['state'] = 'run'
                self.klog.append((me, name, (r[0],), E_OK))
                self._load(self._ctx_of(nxt)['regs'])
                return True
            res = E_OK
        elif name == 'del_sem':
            s = self.sems.get(r[0])
            if self._fail(name): res = E_OBJ
            elif not s or not s['live']: res = E_NOEXS
            else:
                s['live'] = False; res = E_OK
                for tid, cnt in s['waiters']:
                    self._ctx_of(tid)['regs'][0] = E_DLT & 0xFFFFFFFF
                    if tid: self.tasks[tid]['state'] = 'ready'
                    self.ready.append(tid)
                s['waiters'] = []
        self.klog.append((self.cur, name, tuple(r[:3]), res))
        self._ret(res)
        return True

    def count_insns(self):
        """probe clock = module instructions executed (any task): the module's own probe words (jobs, waits) become instruction
        counts, 1 tick = 1 instruction (slow: a hook on every block of the module)"""
        self.insn_clock = True
        def blk(uc, addr, size, user): self.insns += size >> 2
        self.mu.hook_add(UC_HOOK_BLOCK, blk, begin=self.mod_range[0], end=self.mod_range[1])

    def preempt(self):
        """end of a time slice: the next ready task (if any) gets the CPU"""
        if not self.ready: return
        self.preempts += 1
        regs = self._save()
        me = self.cur
        self._ctx_of(me)['regs'] = regs
        if me: self.tasks[me]['state'] = 'ready'
        self.ready.append(me)
        nxt = self.ready.pop(0)
        self.cur = nxt
        if nxt: self.tasks[nxt]['state'] = 'run'
        self._load(self._ctx_of(nxt)['regs'])

    def emu(self, begin, until, count):
        """emu_start, with time slices while worker tasks exist"""
        pc, left = begin, count
        while True:
            self._halted = False; self._resched = False
            sliced = bool(self.live())
            n = min(left, self.slice + self.krng.randrange(self.slice)) if sliced else left
            if sliced and self.cur and self.task_weight:          # a slow worker: shorter turns (the n-th task made, 1 = first)
                order = sorted(self.tasks).index(self.cur) % 2 + 1
                n = max(20, int(n * self.task_weight.get(order, 1.0)))
            self.mu.emu_start(pc, until, count=n)
            pc = self.mu.reg_read(UC_ARM_REG_PC)
            if self._halted or (pc == until and self.cur == 0): return
            if self._resched: continue                     # the first worker started: from here on, time slices
            if not sliced: return                          # the instruction budget is used up (as before)
            left -= n
            if left <= 0: return
            if not self.live(): continue                   # the workers have ended: on without slices
            self.preempt()
            pc = self.mu.reg_read(UC_ARM_REG_PC)

    def kernel_clean(self):
        """(every task the module made has exited or was deleted while dormant, every semaphore deleted, task 0 has the CPU)"""
        return all(t['state'] in ('gone', 'deleted') for t in self.tasks.values()) and all(not s['live'] for s in self.sems.values()) and self.cur == 0


class Cam(Kernel):
    def __init__(self, rtos, slice_=20000, seed=1):
        self.rt = open(rtos, 'rb').read() if isinstance(rtos, str) else rtos
        mu = self.mu = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        mu.mem_map(BASE, (len(self.rt) + 0xFFFFF) & ~0xFFFFF); mu.mem_write(BASE, self.rt)
        mu.mem_map(0x55000000, 0x01000000)
        mu.mem_write(RAM_DST, self.rt[RAM_SRC - BASE:RAM_SRC - BASE + RAM_LEN])
        mu.mem_map(OBJ, 0x04000000); mu.mem_map(IMG, 0x10000000); mu.mem_map(POOL, 0x20000000)
        mu.mem_map(FAKE, 0x10000); mu.mem_map(0x7E000000, 0x00200000)
        mu.mem_map(REC_POOL_PAGE, 0x40000)   # the recipe pool page the module dumps (log version 11): zeros unless a test puts recipes there
        mu.reg_write(UC_ARM_REG_C1_C0_2, mu.reg_read(UC_ARM_REG_C1_C0_2) | (0xF << 20))
        mu.reg_write(UC_ARM_REG_FPEXC, 0x40000000)
        mu.mem_write(SENTINEL, struct.pack('<I', 0xE320F000))
        self.heap = HEAP; self.pool = POOL + 64; self.clock = 0x80000000; self.step = 2700   # 100 us per tick() call
        self.app_posts = []; self.fe_posts = []; self.fe_post_ret = []; self.lv_starts = []
        self.allocs = {}; self.frees = []; self.pool_live = {}; self.flushes = []; self.discards = []; self.files = []; self.opens = []; self.locks = []
        # free blocks of IMAGE1 (0) and IMAGE2 (1), bytes; default: the first group of the camera run of 2026-11-21
        # (IMAGE1 241 MB free, largest 188; IMAGE2 698 MB free, largest 680); allocations come from the largest block
        self.free = {0: [188 << 20, 53 << 20], 1: [680 << 20, 18 << 20]}; self.from_largest = True; self.alloc_fail = False; self.pool_log = []
        # reuse: freed addresses are handed out again (first fit by size), as a real allocator would; off by default
        self.reuse = False; self.reuse_list = []; self.free_calls = []; self.pool_addrs = []   # every address Alloc handed out
        # objects: timer holder, timer, image allocator, cache, file service
        self.TH, self.TM, self.IA, self.CA, self.FH, self.FS, self.VT = OBJ + 0x100, OBJ + 0x200, OBJ + 0x300, OBJ + 0x400, OBJ + 0x500, OBJ + 0x600, OBJ + 0x700
        self.w32(self.TH + 0xC, self.TM); self.w32(self.TM + 8, 0xFFFFFFFF)
        self.w32(self.FH + 0x14, self.FS); self.w32(self.FS, self.VT)
        self.OPEN, self.WRITE, self.CLOSE = FAKE + 0x100, FAKE + 0x200, FAKE + 0x300
        self.w32(self.VT + 0x20, self.OPEN); self.w32(self.VT + 0x2C, self.WRITE); self.w32(self.VT + 0x24, self.CLOSE)
        self.handle_open = None
        for a in (OP_NEW, OP_DELETE, OP_NEW_A, OP_DELETE_A, TICK, IMG_OBJ, IMG_ALLOC, IMG_FREE, POOL_FREE_BODY, IMG_SIZE, CACHE_OBJ, FLUSH, DISCARD, FILE_HOLDER, TIMER_HOLDER,
                  ASSERT, LOCK, UNLOCK, self.OPEN, self.WRITE, self.CLOSE, APP_QUEUE, APP_POST, FE_POST):
            mu.hook_add(UC_HOOK_CODE, self._native, begin=a, end=a)
        self.extra = {}
        self.svcs = []
        def intr(uc, intno, user):     # kernel calls (svc): logged, answered E_OK (blind spot: tasks, semaphores, mutexes)
            pc = uc.reg_read(UC_ARM_REG_PC)
            self.svcs.append((pc, uc.reg_read(UC_ARM_REG_IP)))
            uc.reg_write(UC_ARM_REG_R0, 0)
        mu.hook_add(UC_HOOK_INTR, intr)
        def bad(uc, access, addr, size, val, user):
            print('UNMAPPED access %d addr %#x pc %#x lr %#x' % (access, addr, uc.reg_read(UC_ARM_REG_PC), uc.reg_read(UC_ARM_REG_LR)))
            return False
        mu.hook_add(UC_HOOK_MEM_UNMAPPED, bad)
        self.kernel_init(slice_, seed)
        self.card_opens = []; self.sunk = []
        # mf24: a recording build (mf19 .. mf23, PROBES 1) hooks the playback post 0x53262D1C; the final build (PROBES 0) leaves it stock
        self.probes = struct.unpack_from('<I', self.rt, 0x53262D1C - BASE)[0] != 0xE1A0C00D
        self._sink_install()
        ctx = getattr(self, 'ctx_addr', None)
        self.slot = self.r32(ctx + 4) if ctx else SLOT        # (a build's own)
        self.switch = self.r32(ctx + 8) if ctx else SWITCH
        self.w8(CUR + 0x49E, 2)          # file format RAW+JPEG, as the switch sets it (mf17: the front end holds live view only then)

    def _sink_install(self):
        """mf24 (mfmod.c PROBES 0): the final build writes no record; its ctx word log_sink (+0xC8, after set_review 0x5333E5F8 at +0xC4)
        is 0 on the camera.  Here it is pointed at a recorder that files the record as the recording build's file service would have
        (same name, same bytes), so the tests read the group records of both builds the same way; self.sunk lists them, self.card_opens
        only what the module really opened through the file service."""
        ctx = getattr(self, 'ctx_addr', None)
        if not ctx or self.r32(ctx + 0xC4) != 0x5333E5F8 or self.r32(ctx + 0xC8) != 0: return
        SINK = FAKE + 0x400
        self.w32(ctx + 0xC8, SINK)
        def sink(uc, *_):
            kind, tick, data, n = [uc.reg_read(r) for r in REGS[:4]]
            name = 'C:\\M%c%06X.BIN' % (chr(kind & 0xFF), (tick >> 8) & 0xFFFFFF)
            self.opens.append(name); self.files.append([name, self.rb(data, n)]); self.sunk.append(name)
            self._ret(0)
        self.mu.hook_add(UC_HOOK_CODE, sink, begin=SINK, end=SINK)

    def lv_start_native(self):
        """StartLiveView 0x536520E0 answered by a recorder (blind spot: the live-view process is not run)"""
        self.mu.hook_add(UC_HOOK_CODE, self._native, begin=START_LV, end=START_LV)

    def module_call(self, which, a, b, e=0):
        """the module's entry mfmod(ctx, which, a, b, e) (the 5th argument on the stack)"""
        sp = STACK_TOP - 0x2000
        self.w32(sp, e)
        for r, v in zip(REGS, (self.ctx_addr, which, a, b)): self.mu.reg_write(r, v & 0xFFFFFFFF)
        self.mu.reg_write(UC_ARM_REG_SP, sp); self.mu.reg_write(UC_ARM_REG_LR, SENTINEL)
        self.emu(self.mod_range[0], SENTINEL, 400_000_000)
        return self.mu.reg_read(UC_ARM_REG_R0)

    def cut_property_store(self, lo=0x53770000, hi=0x53790000):
        """Calls from outside into the property store code (setting records, their messages to other tasks) return 0 at once
        and are logged in self.props as (entry, r0, r1, r2) (blind spot)."""
        self.props = []
        def blk(uc, addr, size, user):
            lr = uc.reg_read(UC_ARM_REG_LR)
            if not (lo <= lr < hi) and not (lo <= lr - 4 < hi):
                self.props.append((addr, uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2)))
                self._ret(0)
        self.mu.hook_add(UC_HOOK_BLOCK, blk, begin=lo, end=hi - 1)

    def factory_settings(self, record=0):
        """CURRENT() as the camera has it after a settings reset: factory record `record` of UserDataInitValue 0x53546C24
        (run here) in the stored and the live copy; the two singletons (application, CURRENT) marked constructed."""
        self.call(0x53546C24)
        rec = self.rb(0x5508BA28 + record * 0xB44, 0xB44)
        self.wb(CUR + 4, rec); self.wb(CUR + 0xB48, rec)
        self.w32(0x55083244, 1); self.w32(0x5508307C, 1)
        assert self.call(0x53240C38) == CUR

    # -- memory helpers
    def w32(self, a, v): self.mu.mem_write(a, struct.pack('<I', v & 0xFFFFFFFF))
    def r32(self, a): return struct.unpack('<I', bytes(self.mu.mem_read(a, 4)))[0]
    def w16(self, a, v): self.mu.mem_write(a, struct.pack('<H', v & 0xFFFF))
    def r16(self, a): return struct.unpack('<H', bytes(self.mu.mem_read(a, 2)))[0]
    def w8(self, a, v): self.mu.mem_write(a, bytes([v & 0xFF]))
    def r8(self, a): return self.mu.mem_read(a, 1)[0]
    def rb(self, a, n): return bytes(self.mu.mem_read(a, n))
    def wb(self, a, b): self.mu.mem_write(a, bytes(b))
    def reg(self, r): return self.mu.reg_read(r)

    def _ret(self, v=None):
        if v is not None: self.mu.reg_write(UC_ARM_REG_R0, v & 0xFFFFFFFF)
        self.mu.reg_write(UC_ARM_REG_PC, self.mu.reg_read(UC_ARM_REG_LR))

    def _native(self, uc, addr, size, user):
        r = [uc.reg_read(x) for x in REGS[:4]]
        if addr in self.extra:
            return self.extra[addr](self, r)
        if addr in KSTUBS:
            self._kernel(KSTUBS[addr], r); return
        if addr in (OP_NEW, OP_NEW_A):
            p = self.heap; self.heap += (r[0] + 15) & ~15; uc.mem_write(p, b'\xaa' * r[0]); self.allocs[p] = r[0]; return self._ret(p)
        if addr in (OP_DELETE, OP_DELETE_A): self.frees.append(r[0]); return self._ret(0)
        if addr == TICK:                 # the emulated clock moves with the caller's (task 0's) readings only, not the probes'
            if self._probe_task is not None and self._probe_task == self.cur:
                self._probe_task = None; self.probe_reads += 1
                if self.insn_clock: return self._ret((self.clock - self.insns) & 0xFFFFFFFF)   # 1 tick per module instruction
                return self._ret(self.clock)
            if self.cur == 0: self.clock = (self.clock - self.step) & 0xFFFFFFFF
            if getattr(self, 'on_tick', None): self.on_tick(self)
            return self._ret(self.clock)
        if addr == TIMER_HOLDER: return self._ret(self.TH)
        if addr == IMG_OBJ: return self._ret(self.IA)
        if addr == IMG_ALLOC:
            size, typ = r[1], r[2]
            blocks = self.free.get(typ) if typ in (0, 1) or self.reuse else None      # (other pool types: only in the hold tests)
            if self.alloc_fail or blocks is None: return self._ret(0)
            fit = [i for i, b in enumerate(blocks) if b > size]
            if not fit or max(blocks) <= size: return self._ret(0)       # the stock rule: largest free > size
            i = max(fit, key=lambda i: blocks[i]) if self.from_largest else min(fit, key=lambda i: blocks[i])
            hit = next((k for k, (a, z) in enumerate(self.reuse_list) if z >= size), None) if self.reuse else None
            if hit is not None: p = self.reuse_list.pop(hit)[0]
            else:
                p = (self.pool + 63) & ~63
                if p + size > POOL + 0x20000000: raise RuntimeError('emulator pool area full')
                self.pool = p + size
            blocks[i] -= size; self.pool_live[p] = (typ, i, size); self.pool_log.append(('alloc', typ, size)); self.pool_addrs.append(p)
            self.w32(p - 8, p - 0x10)                 # the pool's block header (0x53905B14: non-zero while allocated)
            return self._ret(p)
        if addr == IMG_FREE:                  # Free: on to the pool's free method, lr kept (as its tail call)
            uc.reg_write(UC_ARM_REG_R0, self.IA + 0x80); uc.reg_write(UC_ARM_REG_PC, POOL_FREE); return
        if addr == POOL_FREE_BODY:            # answers 1 (the stock Free's "freeOk"; the stock check after it logs an error on 0)
            self.free_calls.append((r[1], uc.reg_read(UC_ARM_REG_LR), getattr(self, 'cur', 0)))
            if r[1] in self.pool_live:
                typ, i, size = self.pool_live.pop(r[1]); self.free[typ][i] += size; self.pool_log.append(('free', typ, size))
                self.w32(r[1] - 8, 0)                 # the free method clears the header (0x53905E5C)
                if self.reuse: self.reuse_list.append((r[1], size))
            elif self.reuse and r[1]: raise RuntimeError(f'Free of {r[1]:#x}: not an allocated block (double free?)')
            self.frees.append(r[1]); return self._ret(1)
        if addr == IMG_SIZE:
            blocks = self.free.get(r[3], [0])
            self.w32(r[1], sum(blocks)); self.w32(r[2], max(blocks)); return self._ret(0)
        if addr == CACHE_OBJ: return self._ret(self.CA)
        if addr == FLUSH:
            self.flushes.append((r[1], r[2]))
            if getattr(self, 'on_flush', None): f = self.on_flush; self.on_flush = None; f(self)
            return self._ret(0)
        if addr == DISCARD: self.discards.append((r[1], r[2])); return self._ret(0)
        if addr == FILE_HOLDER: return self._ret(self.FH)
        if addr == self.OPEN:
            name = self.rb(r[1], 16).split(b'\0')[0].decode(); self.opens.append(name); self.card_opens.append(name); self.w32(r[3], 7); self.files.append([name, b'']); return self._ret(1)
        if addr == self.WRITE: self.files[-1][1] += self.rb(r[2], r[3]); return self._ret(r[3])
        if addr == self.CLOSE: return self._ret(1)
        if addr == ASSERT: return self._ret(1)
        if addr in (LOCK, UNLOCK): self.locks.append(addr); return self._ret(0)
        if addr == APP_QUEUE: return self._ret(APP_Q)
        if addr == FE_POST:              # recorded: (SEQ + 0x10, the 7 message words, the task that posted); answer from fe_post_ret
            self.fe_posts.append(dict(obj=r[0], msg=struct.unpack('<7I', self.rb(r[1], 28)), task=getattr(self, 'cur', 0), clock=self.clock))
            return self._ret(self.fe_post_ret.pop(0) if self.fe_post_ret else 0)
        if addr == START_LV:             # (only with lv_start_native()) recorded, answers 1 (started)
            self.lv_starts.append(dict(regs=tuple(r), stack=struct.unpack('<2I', self.rb(self.mu.reg_read(UC_ARM_REG_SP), 8))))
            return self._ret(1)
        if addr == APP_POST:
            st = self.r32(self.slot); busy = self.r32(st + 4) if st else None
            self.app_posts.append(dict(args=tuple(r), busy=busy, clock=self.clock)); return self._ret(0)

    def run(self, start, until, regs=None, count=4_000_000_000):
        for k, v in (regs or {}).items(): self.mu.reg_write(k, v & 0xFFFFFFFF)
        self.emu(start, until, count)

    def call(self, fn, *args, count=4_000_000_000):
        for r, v in zip(REGS, args[:4]): self.mu.reg_write(r, v & 0xFFFFFFFF)
        self.mu.reg_write(UC_ARM_REG_SP, STACK_TOP - 0x40); self.mu.reg_write(UC_ARM_REG_LR, SENTINEL)
        self.emu(fn, SENTINEL, count)
        return self.mu.reg_read(UC_ARM_REG_R0)

    def stack_paint(self):
        self.wb(0x7E000100, b'\xcd' * (0x100000 - 0x100 - 0x40))

    def stack_depth(self):
        b = self.rb(0x7E000100, 0x100000 - 0x100 - 0x40)
        i = 0
        while i < len(b) and b[i] == 0xCD: i += 1
        return (0x7E000100 + len(b)) - (0x7E000100 + i)


# ---- a recipe and its ShootingInfo, built by the camera's own constructor -----------------------------------------------

class Recipe:
    def __init__(self, cam, slot, width, height, si):
        """slot: index of this recipe's memory; si: dict of ShootingInfo fields (offset -> (size, value))."""
        e = self.cam = cam
        self.prop = OBJ + 0x0100000 + slot * 0x10000
        self.shoot = OBJ + 0x0400000 + slot * 0x80000
        self.aux = OBJ + 0x0F00000 + slot * 0x1000
        self.params = OBJ + 0x0F80000 + slot * 0x100
        self.info = OBJ + 0x0FC0000 + slot * 0x100
        self.ctx = OBJ + 0x1000000 + slot * 0x10000
        self.process = OBJ + 0x1100000 + slot * 0x10000
        self.width, self.height = width, height
        self.size = 2 * width * (height + 128) + 0x440
        self.alloc = IMG + 0x100 + slot * ((self.size + 0xFFFF) & ~0xFFFF)
        self.bayer = ((self.alloc + 128 * width + 63) & ~63) - 0x10        # as SetBufferAddress, then PRO_SRO's -0x10
        e.wb(self.prop, bytes([0xA5]) * 0x5000); e.wb(self.aux, bytes(0x1000)); e.wb(self.shoot, bytes(0x74800))
        e.wb(self.ctx, bytes(0x2000)); e.wb(self.process, bytes(0x9000)); e.wb(self.params, bytes(0x100)); e.wb(self.info, bytes(0x100))
        for off, (n, v) in si.items():
            if n == 1: e.w8(self.shoot + off, v)
            elif n == 2: e.w16(self.shoot + off, v)
            else: e.w32(self.shoot + off, v)
        hooks = []
        def dep(uc, addr, size, user):
            if addr == 0x538A067C: e._ret(0x600C0000 + slot * 0x2000)
            elif addr == 0x538A0E68: e._ret(0x600C1000 + slot * 0x2000)
            elif addr == 0x5389FD0C: e._ret(0)
            else: e._ret(uc.reg_read(UC_ARM_REG_R0))
        for a in CTOR_DEPS: hooks.append(e.mu.hook_add(UC_HOOK_CODE, dep, begin=a, end=a))
        stop = e.mu.hook_add(UC_HOOK_CODE, lambda uc, *_: uc.emu_stop(), begin=0x53735460, end=0x53735460)
        e.call(0x53734828, self.prop, self.shoot, self.aux, count=100000)
        assert e.reg(UC_ARM_REG_PC) == 0x53735460 and e.r32(self.prop + 0x4688) == self.shoot
        for h in hooks + [stop]: e.mu.hook_del(h)
        # +0x60 as SetBufferAddress leaves it; the PRO_SRO config (module 0) moves it by -0x10 to where the data is
        e.w32(self.prop + 0x60, self.bayer + 0x10); e.w32(self.prop + 0x190, IMG + 0xF000000 + slot * 0x100000)
        e.w32(self.prop + 0x18, 1); e.w32(self.prop + 0x5C, self.params); e.w32(self.prop + 0x29C, self.info)
        e.w16(self.info + 0x20, width); e.w16(self.info + 0x22, height); e.w16(self.prop + 0x2BA, width)
        e.w32(self.prop + 0x3BC, self.size); e.w32(self.prop + 0x358, self.alloc)
        e.w32(self.alloc - 8, self.alloc - 0x10)        # its pool block header (non-zero while allocated, as the pool writes it)
        e.w8(self.params + 0xD, 1); e.w8(self.params + 0xC, 1); e.w8(self.params + 0x1F, 3)
        e.w32(self.ctx + 0xC3C + 9 * 4, 0x01000001); e.w32(self.ctx + 0xBD0 + 9 * 4, self.process)

    def put_bayer(self, cfa):
        assert cfa.shape == (self.height, self.width)
        self.cam.wb(self.bayer, cfa.astype('<u2').tobytes())

    def get_bayer(self):
        import numpy as np
        return np.frombuffer(self.cam.rb(self.bayer, 2 * self.width * self.height), dtype='<u2').reshape(self.height, self.width).copy()

    def module(self, mid=9):
        """The stock fragment from 0x53745684 up to the post of the module request; returns the post's arguments."""
        e = self.cam; got = []
        def post(uc, *_):
            got.append([uc.reg_read(r) for r in REGS[:4]]); uc.emu_stop()
        h = e.mu.hook_add(UC_HOOK_CODE, post, begin=0x53904F3C, end=0x53904F3C)
        e.w32(self.ctx + 0xC3C + mid * 4, 0x01000001); e.w32(self.ctx + 0xBD0 + mid * 4, self.process)
        e.mu.reg_write(UC_ARM_REG_SP, STACK_TOP - 0x1000); e.mu.reg_write(UC_ARM_REG_FP, STACK_TOP - 0xF00)
        e.run(0x53745684, 0x53904F40, {UC_ARM_REG_R0: self.prop, UC_ARM_REG_R1: mid, UC_ARM_REG_R4: self.prop, UC_ARM_REG_R5: mid,
                                        UC_ARM_REG_R6: self.ctx, UC_ARM_REG_R8: 0})
        e.mu.hook_del(h)
        assert e.reg(UC_ARM_REG_PC) == 0x53904F3C and len(got) == 1, hex(e.reg(UC_ARM_REG_PC))
        regs = [e.reg(r) for r in REGS] + [e.reg(UC_ARM_REG_SP)]
        req = got[0][1]
        return dict(post=got[0], regs=regs, request=e.rb(req, 0x18), args=e.rb(e.r32(req + 8), 0x80) if e.r32(req + 8) else b'')


def si_fields(sv=9.0, tv=6.0, av=4.0, drive=1, black=(512,) * 4, white=15868, index=0, develop=0, cfa=0, hc=0, hc_set=0):
    d = {0xBB7: (1, hc), 0x7E4: (1, hc_set), 0xB11: (1, develop), 0x7BC: (1, drive), 0xBA0: (4, f32(sv)), 0xB9C: (4, f32(tv)), 0xB98: (4, f32(av)), 0xB10: (1, cfa),
         0xB12: (2, 14), 0x960: (4, index), 0x38BF4: (4, white)}
    for i, b in enumerate(black): d[0x38BE4 + 4 * i] = (4, b)
    return d


def sha(b): return hashlib.sha256(b).hexdigest()


def mf_files(c):
    """the group log files C:\\MF* the module wrote (mf17 also writes per-press files C:\\MP*)"""
    return [f for f in c.files if f[0].startswith('C:\\MF')]
