# SPDX-License-Identifier: GPL-2.0-only
"""Checks the reference tool does not make: that the patched firmware behaves like the official
one wherever no added ratio is involved.

Every instruction the patch replaces inside the official image is a jump into appended code. For
each such "hook" this runs the official and the patched image side by side in an emulator
(Unicorn) from that instruction, with the same random registers, flags, stack and memory, in which
no value is an added ratio's identity. The patched run must come back into official code at some
address with exactly the state the official run has when it gets there: same registers, same
flags, same memory. A few hooks change behaviour on purpose even then (a larger allocation, a
wrapper around a whole function); those are compared at the level they are meant to be equal and
are listed in SPECIAL below with the reason.

Also checked: the relocated text and icon directories return what the originals did, for every
language and every identifier; the two text bound checks; the menu count, order and Fn cycling;
the settings load / save / recall wrappers.

Run through verify_file.py --boot, or directly: python3 boot_checks.py PATCHED_RTOS.bin
"""
import random
import struct
import sys

from unicorn import Uc, UcError, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE, UC_HOOK_MEM_WRITE, UC_PROT_READ, UC_PROT_EXEC, UC_PROT_ALL
from unicorn import arm_const as reg

BASE = 0x53000000
OFFICIAL_LEN = 0x13D2AC0
RAM, RAM_SRC, RAM_LEN = 0x55000000, 0x5437B640, 0x57480
# Fake data regions. Their addresses are chosen so that no byte, half-word or word of a pointer
# into them can be mistaken for an added ratio's identity (7..14) or a small enum.
REGIONS = [0x62010000, 0x62020000, 0x62030000, 0x62050000]
REGION_SIZE = 0x10000
STACK = 0x61000000
STACK_SIZE = 0x20000
REGS = [getattr(reg, 'UC_ARM_REG_R%d' % n) for n in range(13)] + [reg.UC_ARM_REG_SP, reg.UC_ARM_REG_LR]
NAMES = ['r%d' % n for n in range(13)] + ['sp', 'lr']


def u32(image, address):
    return struct.unpack_from('<I', image, address - BASE)[0]


def branch_target(at, word):
    d = word & 0xFFFFFF
    if d & 0x800000:
        d -= 1 << 24
    return at + 8 + d * 4


class Machine:
    def __init__(self, image):
        self.image = bytes(image)
        size = (len(self.image) + 0xFFF) & ~0xFFF
        self.uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        self.uc.mem_map(BASE, size, UC_PROT_READ | UC_PROT_EXEC)
        self.uc.mem_write(BASE, self.image)
        self.uc.mem_map(RAM, 0x400000, UC_PROT_ALL)
        self.uc.mem_map(STACK, STACK_SIZE, UC_PROT_ALL)
        for region in REGIONS:
            self.uc.mem_map(region, REGION_SIZE, UC_PROT_ALL)
        self.uc.reg_write(reg.UC_ARM_REG_C1_C0_2, 0xF00000)
        self.uc.reg_write(reg.UC_ARM_REG_FPEXC, 0x40000000)
        self.writes = []
        self.stop_at = None
        self.trace_pc = None
        self.uc.hook_add(UC_HOOK_MEM_WRITE, self._write)
        self.uc.hook_add(UC_HOOK_CODE, self._code)
        self.stubs = {}

    def _write(self, uc, access, address, size, value, data):
        self.writes.append((address, size, value & ((1 << (8 * size)) - 1)))

    def _code(self, uc, address, size, data):
        stub = self.stubs.get(address)
        if stub is not None:
            stub(self)
            return
        if self.stop_at is not None and self.stop_at(address):
            self.trace_pc = address
            uc.emu_stop()

    def reset(self, state):
        self.uc.mem_write(RAM, self.image[RAM_SRC - BASE:RAM_SRC - BASE + RAM_LEN])
        self.uc.mem_write(RAM + RAM_LEN, bytes(0x400000 - RAM_LEN))
        self.uc.mem_write(STACK, state['stack'])
        for region, content in zip(REGIONS, state['regions']):
            self.uc.mem_write(region, content)
        for r, value in zip(REGS, state['regs']):
            self.uc.reg_write(r, value)
        self.uc.reg_write(reg.UC_ARM_REG_CPSR, 0x13 | state['flags'] << 28)
        self.uc.reg_write(reg.UC_ARM_REG_S15, state.get('s15', 0x3F800000))
        self.writes = []
        self.trace_pc = None

    def snapshot(self):
        cpsr = self.uc.reg_read(reg.UC_ARM_REG_CPSR)
        return {
            'regs': [self.uc.reg_read(r) for r in REGS],
            'flags': cpsr >> 28,
            's15': self.uc.reg_read(reg.UC_ARM_REG_S15),
            'stack': bytes(self.uc.mem_read(STACK, STACK_SIZE)),
            'regions': [bytes(self.uc.mem_read(region, REGION_SIZE)) for region in REGIONS],
        }

    def run(self, start, stop_at, limit=4000):
        """Run from `start` until `stop_at(pc)` is true for an instruction about to execute."""
        first = [True]

        def stop(address):
            if first[0]:
                first[0] = False
                return False
            return stop_at(address)
        self.stop_at = stop
        try:
            self.uc.emu_start(start, 0xFFFFFFF0, count=limit)
        except UcError as exc:
            return 'fault: %s at pc=%#x' % (exc, self.uc.reg_read(reg.UC_ARM_REG_PC))
        finally:
            self.stop_at = None
        if self.trace_pc is None:
            return 'did not stop (pc=%#x)' % self.uc.reg_read(reg.UC_ARM_REG_PC)
        return None


def random_state(rng, tweak=None):
    def pointer():
        return rng.choice(REGIONS) + rng.randrange(0x1000, 0x8000, 4)

    def word():
        # Everything stored in the fake regions is a pointer into them: any load from a loaded
        # pointer stays inside mapped memory, and no byte of it is 4..15.
        return rng.choice(REGIONS) + rng.choice([0, 0x100, 0x1000, 0x2000, 0x3000]) + rng.choice([0, 0x10, 0x20, 0x30, 0x100, 0x200])

    def value():
        kind = rng.random()
        if kind < 0.55:
            return pointer()
        if kind < 0.9:
            return rng.choice([0, 1, 2, 3, 4, 5, 6, 0x100, 0x2000, 46, 720, 480, 160, 120])
        return rng.getrandbits(32) | 0x80000000  # garbage that is never dereferenced as a small id
    regions = []
    for _ in REGIONS:
        regions.append(b''.join(struct.pack('<I', word()) for _ in range(REGION_SIZE // 4)))
    stack = b''.join(struct.pack('<I', word()) for _ in range(STACK_SIZE // 4))
    regs = [value() for _ in range(13)]
    regs[11] = STACK + STACK_SIZE // 2 + 0x2000 + rng.randrange(0, 0x100, 4)  # fp: a frame above sp
    regs.append(STACK + STACK_SIZE // 2 + rng.randrange(0, 0x100, 8))  # sp
    regs.append(BASE + 0x100000 + rng.randrange(0, 0x1000, 4))  # lr: somewhere in official code
    state = {'regs': regs, 'flags': rng.randrange(16), 'stack': stack, 'regions': regions}
    if tweak:
        tweak(state, rng)
    return state


def poke(state, address, data):
    if STACK <= address < STACK + STACK_SIZE:
        buffer = bytearray(state['stack'])
        buffer[address - STACK:address - STACK + len(data)] = data
        state['stack'] = bytes(buffer)
        return
    for index, region in enumerate(REGIONS):
        if region <= address < region + REGION_SIZE:
            buffer = bytearray(state['regions'][index])
            buffer[address - region:address - region + len(data)] = data
            state['regions'][index] = bytes(buffer)
            return
    raise ValueError('poke outside the fake memory')


def peek(state, address, size):
    if STACK <= address < STACK + STACK_SIZE:
        return state['stack'][address - STACK:address - STACK + size]
    for index, region in enumerate(REGIONS):
        if region <= address < region + REGION_SIZE:
            return state['regions'][index][address - region:address - region + size]
    raise ValueError('peek outside the fake memory')


def differences(a, b, ignore=()):
    out = []
    for name, x, y in zip(NAMES, a['regs'], b['regs']):
        if x != y and name not in ignore:
            out.append('%s %#x / %#x' % (name, x, y))
    if a['flags'] != b['flags'] and 'flags' not in ignore:
        out.append('flags %x / %x' % (a['flags'], b['flags']))
    if a['s15'] != b['s15']:
        out.append('s15')
    # Only the live part of the stack counts: what lies below sp belongs to nobody.
    live = max(0, min(a['regs'][13], b['regs'][13]) - STACK)
    if a['stack'][live:] != b['stack'][live:] and 'stack' not in ignore:
        at = next(i for i in range(live, STACK_SIZE) if a['stack'][i] != b['stack'][i])
        out.append('stack at %#x' % (STACK + at))
    for region, x, y in zip(REGIONS, a['regions'], b['regions']):
        if x != y and 'memory' not in ignore:
            at = next(i for i in range(REGION_SIZE) if x[i] != y[i])
            out.append('memory at %#x' % (region + at))
    return out


# Hooks that are not transparent instruction replacements, and how they are compared instead.
#   'entry'  a whole function is wrapped or replaced: handled by the function-level checks below.
#   dict     compare at the sync point but ignore the named registers; `why` says why that is right.
SPECIAL = {
    0x53877334: {'ignore': ('r12', 'flags'), 'tweak': 'not_first_record',
                 'why': 'the displaced "mov r0,#46" is directly followed by a call, which may clobber ip and '
                        'the flags anyway; for the first record of a map (r4 - sl == 4) the size is enlarged on purpose'},
    0x53877C9C: 'entry', 0x533E1C04: 'entry', 0x533E17CC: 'entry', 0x537F6AAC: 'entry',
    0x5337FBAC: 'entry', 0x5338143C: 'entry', 0x5374ACFC: 'entry',
    0x5336B768: 'entry', 0x5336B8C4: 'entry', 0x5336D814: 'entry', 0x53374D20: 'entry', 0x53375088: 'entry',
    0x5325AE34: 'entry',
    0x532A90CC: {'ignore': (), 'tweak': 'valid_current_ratio',
                 'why': 'resets the current ratio when it is not in the menu; transparent when it is a menu ratio'},
    0x536CD414: 'entry',
}


# Hooks whose displaced instruction is conditional: include the instruction(s) before it, which set the flags.
LEAD = {0x5364DEE4: 1, 0x5364E484: 1, 0x5388BE10: 1}


def hooks_of(official, patched):
    """Addresses in the official part whose word changed into a B/BL to the appended area."""
    hooks, data = [], []
    for offset in range(0, OFFICIAL_LEN, 4):
        if official[offset:offset + 4] == patched[offset:offset + 4]:
            continue
        address = BASE + offset
        word = struct.unpack_from('<I', patched, offset)[0]
        if word & 0x0E000000 == 0x0A000000 and branch_target(address, word) >= BASE + OFFICIAL_LEN:
            hooks.append(address)
        else:
            data.append(address)
    return hooks, data


def flags_dead(image, pc, limit=128):
    """True when the official code at `pc` sets the flags (or calls / returns) before using them."""
    from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM
    from capstone.arm import ARM_CC_AL, ARM_CC_INVALID
    md = Cs(CS_ARCH_ARM, CS_MODE_ARM)
    md.detail = True
    for _ in range(limit):
        code = image[pc - BASE:pc - BASE + 4]
        insn = next(md.disasm(code, pc), None)
        if insn is None:
            return False
        if insn.cc not in (ARM_CC_AL, ARM_CC_INVALID):
            return False  # a conditional instruction reads the flags
        name = insn.mnemonic
        if name in ('adc', 'sbc', 'rsc', 'rrx', 'adcs', 'sbcs', 'rscs', 'mrs'):
            return False  # reads the carry or the status register
        if name in ('cmp', 'cmn', 'tst', 'teq') or insn.update_flags:
            return True
        if name in ('bl', 'blx'):
            return True  # flags are not preserved across a call
        if name == 'bx' or (name in ('pop', 'ldm') and 'pc' in insn.op_str):
            return True  # return: the caller cannot rely on flags
        if name == 'b':
            pc = int(insn.op_str.lstrip('#'), 0)
            continue
        if 'pc' in insn.op_str.split(',')[0] and name in ('mov', 'add', 'ldr'):
            return False  # computed jump: give up
        pc += 4
    return False


def register_dead(image, pc, name, limit=96, depth=3):
    """True when, on every path from `pc`, the official code overwrites register `name` (or calls,
    for ip, which no callee may rely on) before reading it. Conservative: anything unclear is "live"."""
    from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM
    from capstone.arm import ARM_CC_AL, ARM_CC_INVALID
    md = Cs(CS_ARCH_ARM, CS_MODE_ARM)
    md.detail = True
    alias = {'r9': 'sb', 'r10': 'sl', 'r11': 'fp', 'r12': 'ip'}.get(name, name)
    for _ in range(limit):
        insn = next(md.disasm(image[pc - BASE:pc - BASE + 4], pc), None)
        if insn is None:
            return False
        read, written = insn.regs_access()
        if alias in [insn.reg_name(r) for r in read]:
            return False
        conditional = insn.cc not in (ARM_CC_AL, ARM_CC_INVALID)
        if alias in [insn.reg_name(r) for r in written] and not conditional:
            return True
        if insn.mnemonic in ('bl', 'blx') and not conditional:
            return name == 'r12'  # r0-r3 may be arguments; ip is dead across a call
        if insn.mnemonic == 'bx' or (insn.mnemonic in ('pop', 'ldm') and 'pc' in insn.op_str):
            return False
        if insn.mnemonic == 'b' or (conditional and insn.mnemonic.startswith('b') and insn.mnemonic[1:] in
                                    ('eq', 'ne', 'hs', 'cs', 'lo', 'cc', 'mi', 'pl', 'vs', 'vc', 'hi', 'ls', 'ge', 'lt', 'gt', 'le')):
            target = int(insn.op_str.lstrip('#'), 0)
            if not conditional:
                pc = target
                continue
            if depth == 0:
                return False
            return register_dead(image, target, name, limit, depth - 1) and register_dead(image, pc + 4, name, limit, depth - 1)
        if 'pc' in insn.op_str.split(',')[0]:
            return False  # computed jump
        pc += 4
    return False


# Differences the automatic analysis cannot settle, reviewed by hand against the disassembly.
REVIEWED = {
    (0x5388AF1C, 'r12'): 'at 0x5388AF20 the native code sets ip with "movhi ip,#0" / "movls ip,#1" (one of the two '
                         'always executes) before the jump table and never reads the incoming value',
}


def check_transparent(official, patched, hooks, runs=40, seed=1, lead=None):
    """`lead[site]` = number of instructions before the hook to include in both runs (to establish
    the flags the displaced conditional instruction depends on)."""
    mo, mp = Machine(official), Machine(patched)
    lead = lead or {}
    failures, tested, notes = [], 0, {}
    for site in hooks:
        special = SPECIAL.get(site)
        if special == 'entry':
            continue
        ignore = special['ignore'] if special else ()
        rng = random.Random(seed * 1000003 + site)
        start = site - 4 * lead.get(site, 0)
        good, tries, ok = 0, 0, True
        flag_syncs = set()
        dead_cache = {}
        while good < runs and tries < runs * 30 and ok:
            tries += 1

            def tweak(state, rng, site=site, special=special):
                if special and special.get('tweak') == 'not_first_record':
                    # r4 - r10 == 4 selects the enlarged allocation: tested separately.
                    while (state['regs'][4] - state['regs'][10]) & 0xFFFFFFFF == 4:
                        state['regs'][4] += 4
                if special and special.get('tweak') == 'valid_current_ratio':
                    # r4 points at the user data; its ratio byte (+0x49F) holds a menu ratio.
                    state['regs'][4] = REGIONS[0] + 0x1000
                    poke(state, REGIONS[0] + 0x1000 + 0x49F, bytes([rng.choice([0, 1, 2, 3])]))
            state = random_state(rng, tweak)
            mp.reset(state)
            left = [False]

            def back_in_official(address):
                if address >= BASE + OFFICIAL_LEN:
                    left[0] = True
                    return False
                return left[0]
            problem = mp.run(start, back_in_official)
            if problem:
                if problem.startswith('fault'):
                    continue  # this random state made a pointer register a non-pointer: try another
                failures.append('%#x patched run: %s' % (site, problem))
                ok = False
                break
            sync = mp.trace_pc
            after_patched = mp.snapshot()
            mo.reset(state)
            problem = mo.run(start, lambda address: address == sync, limit=64)
            if problem:
                if problem.startswith('fault'):
                    continue
                failures.append('%#x official run never reaches %#x: %s' % (site, sync, problem))
                ok = False
                break
            after_official = mo.snapshot()
            diff = differences(after_official, after_patched, ignore)
            # A register or the flags may differ only where the official code no longer needs them.
            kept = []
            for item in diff:
                what = item.split()[0]
                key = (sync, what)
                if what == 'flags' or what in NAMES[:13]:
                    if key not in dead_cache:
                        dead_cache[key] = flags_dead(official, sync) if what == 'flags' else register_dead(official, sync, what)
                    if dead_cache[key] or (site, what) in REVIEWED:
                        flag_syncs.add(key)
                        continue
                kept.append(item + (' (still used there)' if what == 'flags' or what in NAMES[:13] else ''))
            diff = kept
            if diff:
                failures.append('%#x differs at %#x: %s' % (site, sync, '; '.join(diff[:6])))
                ok = False
                break
            good += 1
        if ok and good < runs:
            failures.append('%#x: only %d of %d random states ran without a fault' % (site, good, tries))
        elif ok:
            tested += 1
            if flag_syncs:
                notes[site] = sorted('%s at %#x' % (what, at) for at, what in flag_syncs)
    return tested, failures, notes


def call(machine, state, address, stubs=None, limit=20000):
    """Call the function at `address` with the registers of `state`; returns the machine state at return."""
    stop = BASE + 0x100000 + 0x4000
    state = dict(state)
    state['regs'] = list(state['regs'])
    state['regs'][14] = stop
    machine.reset(state)
    machine.stubs = stubs or {}
    try:
        problem = machine.run(address, lambda pc: pc == stop, limit=limit)
    finally:
        machine.stubs = {}
    if problem:
        raise AssertionError('call %#x: %s' % (address, problem))
    return machine.snapshot()


def ret(machine, value=None):
    if value is not None:
        machine.uc.reg_write(reg.UC_ARM_REG_R0, value)
    machine.uc.reg_write(reg.UC_ARM_REG_PC, machine.uc.reg_read(reg.UC_ARM_REG_LR))


def check_directories(official, patched, icon_bytes, official_icons):
    """Text and icon lookups give what the official firmware gives, for every valid identifier."""
    mo, mp = Machine(official), Machine(patched)
    rng = random.Random(7)
    base_state = random_state(rng)
    checked = 0
    new_names = 0
    # (start, id register, language register, address reached with the record pointer, register holding it, skip addresses)
    for start, hit, pointer_reg, skips in ((0x535734F4, 0x53573510, 3, (0x535735E4,)), (0x53572ADC, 0x53572B04, 7, (0x53572C54, 0x53572C60))):
        for language in list(range(21)) + [21, 22, 255]:
            for text in list(range(0, 840)) + list(range(896, 912)) + [0x344, 0x345, 1000, 0xFFFF]:
                state = dict(base_state)
                state['regs'] = list(base_state['regs'])
                state['regs'][0] = language
                state['regs'][7] = text
                results = []
                for machine in (mo, mp):
                    machine.reset(state)
                    problem = machine.run(start, lambda pc: pc == hit or pc in skips or not (BASE <= pc < BASE + len(machine.image)), limit=200)
                    assert not problem, (hex(start), language, text, problem)
                    pc = machine.trace_pc
                    pointer = machine.uc.reg_read(REGS[pointer_reg]) if pc == hit else None
                    results.append((pc == hit, pointer))
                (old_hit, old_pointer), (new_hit, new_pointer) = results
                if text <= 836 and language <= 20:
                    assert old_hit and new_hit and old_pointer == new_pointer, ('text lookup changed', hex(start), language, text)
                elif old_hit:
                    raise AssertionError('official lookup accepted an out-of-range text')
                elif new_hit and new_pointer:
                    # A new name: it must be a valid record {u8 units, u8 lines = 1, u16 0, u32 address of UTF-16 text}.
                    units, lines, zero, address = struct.unpack_from('<BBHI', patched, new_pointer - BASE)
                    assert lines == 1 and zero == 0 and BASE + OFFICIAL_LEN <= address < BASE + len(patched), 'bad text record'
                    raw = patched[address - BASE:address - BASE + units * 2]
                    assert raw[-2:] == b'\0\0' and b'\0\0' not in [raw[i:i + 2] for i in range(0, len(raw) - 2, 2)], 'bad text'
                    new_names += 1
                checked += 1
    # Icon directory: the getter returns a table whose first 663 entries are the official ones.
    old_table = struct.unpack_from('<I', official, 0)[0]  # placeholder, replaced below
    state = random_state(rng)
    getter = 0x533EF604
    old_table = call(mo, state, getter)['regs'][0]
    new_table = call(mp, state, getter)['regs'][0]

    def read(image, address, size):
        if address >= RAM:
            address = RAM_SRC + address - RAM
        return image[address - BASE:address - BASE + size]
    assert read(official, old_table, 663 * 4) == read(patched, new_table, 663 * 4), 'icon directory changed'
    bounds = []
    for site in (0x5323DBB4, 0x5323E40C):
        word = u32(patched, site)
        assert word & 0x0FF00000 == 0x03000000, 'icon bound is not a MOVW'
        bounds.append(((word >> 4) & 0xF000) | (word & 0xFFF))
    assert bounds[0] == bounds[1] < 1024, 'icon bounds differ or exceed the table'
    new_icons = 0
    for index in range(663, 1024):
        pointer = struct.unpack('<I', read(patched, new_table + index * 4, 4))[0]
        if pointer:
            assert index <= bounds[0], 'icon above the bound'
            kind, width, height, flags, words = struct.unpack('<HHHHI', read(patched, pointer, 12))
            assert (kind, width, height, flags) == (1, 60, 40, 0), 'bad icon descriptor'
            assert len(official_icons) <= words * 4 and words * 4 + width * height * 4 <= len(icon_bytes), 'icon pixels outside ICONBIN'
            new_icons += 1
    assert icon_bytes[:len(official_icons)] == official_icons, 'official icon pixels changed'
    return checked, new_names, new_icons


def check_menu(official, patched):
    mo, mp = Machine(official), Machine(patched)
    rng = random.Random(11)
    state = random_state(rng)
    counts = []
    for site in (0x531BA14C, 0x531CF298):
        assert call(mo, state, site)['regs'][0] == 4
        counts.append(call(mp, state, site)['regs'][0])
    assert counts[0] == counts[1] >= 5, 'menu count'
    count = counts[0]
    # Order table: the same address at all seven places, the factory order first.
    tables = set()
    for site in (0x531BAF88, 0x531BB26C, 0x531BE31C, 0x531D0CE8, 0x531D2F88, 0x531D48A0, 0x5325AE2C):
        high = site + (8 if site in (0x531BE31C, 0x531D0CE8) else 4)
        low_word, high_word = u32(patched, site), u32(patched, high)
        assert low_word & 0x0FF0F000 == 0x03003000 and high_word & 0x0FF0F000 == 0x03403000, 'order address is not MOVW/MOVT r3'
        half = lambda w: ((w >> 4) & 0xF000) | (w & 0xFFF)
        tables.add(half(low_word) | half(high_word) << 16)
    assert len(tables) == 1, 'order table addresses differ'
    table = tables.pop()
    order = list(patched[table - BASE:table - BASE + count])
    assert order[:4] == [0, 1, 3, 2] and len(set(order)) == count and all(n >= 7 for n in order[4:]), 'menu order'
    # Validator, name and icon lookups: identical for the factory ratios, defined for the others.
    for public in range(0, 256):
        for r2 in (0, 1):
            st = dict(state)
            st['regs'] = list(state['regs'])
            st['regs'][1] = public
            st['regs'][2] = r2
            new_valid = call(mp, st, 0x5374ACFC)['regs'][0]
            new_text = call(mp, st, 0x5337FBAC)['regs'][0]
            new_icon = call(mp, st, 0x5338143C)['regs'][0]
            assert new_valid == (1 if public in order else 0), 'validator'
            if public <= 3:
                # (The official validator searches a list that only exists at run time, so it cannot be
                # run here; it answers 1 for a listed value and 0 otherwise, as the replacement does.)
                assert call(mo, st, 0x5337FBAC)['regs'][0] == new_text, 'factory name changed'
                assert call(mo, st, 0x5338143C)['regs'][0] == new_icon, 'factory icon changed'
            elif public in order:
                assert new_text >= 901 and (new_icon >= 720 if r2 == 0 else new_icon == 0), 'added ratio name / icon'
            else:
                assert new_text == 0 and new_icon == 0, 'unknown ratio has a name or icon'
    # Fn cycling: from each ratio to the next in menu order, from an unknown one to the first.
    # The code is entered at 0x5325AE34 with r0 = current ratio and r3 = order table and joins the
    # native setter at 0x5325AE6C with the next ratio in r1.
    for current in order + [4, 5, 6, 99, 255]:
        st = dict(state)
        st['regs'] = list(state['regs'])
        st['regs'][0] = current
        st['regs'][3] = table
        mp.reset(st)
        problem = mp.run(0x5325AE34, lambda pc: pc == 0x5325AE6C, limit=5000)
        assert not problem, 'cycle: ' + problem
        chosen = mp.uc.reg_read(reg.UC_ARM_REG_R1)
        expected = order[(order.index(current) + 1) % count] if current in order else order[0]
        assert chosen == expected, ('cycle', current, chosen, expected)
    # The official code does the same for its four ratios.
    old_table = 0x53DBB034
    for current in (0, 1, 3, 2):
        st = dict(state)
        st['regs'] = list(state['regs'])
        st['regs'][0] = current
        st['regs'][3] = old_table
        mo.reset(st)
        problem = mo.run(0x5325AE34, lambda pc: pc == 0x5325AE6C, limit=200)
        assert not problem, 'official cycle: ' + problem
        assert mo.uc.reg_read(reg.UC_ARM_REG_R1) == [0, 1, 3, 2][([0, 1, 3, 2].index(current) + 1) % 4], 'official cycle'
    return count, order


def check_settings(official, patched, order):
    """Settings save / load / user-mode recall: pass through to the native functions untouched,
    and only reset a ratio byte that is not a menu ratio."""
    mp = Machine(patched)
    rng = random.Random(13)
    active = set(order)
    cases = 0
    for trial in range(60):
        state = random_state(rng)
        mode = REGIONS[1] + 0x2000
        current = REGIONS[2] + 0x3000
        user = REGIONS[3] + 0x4000
        snapshots = [REGIONS[0] + 0x1000 + 0x800 * n for n in range(10)]
        if trial % 7 == 3:
            snapshots[rng.randrange(10)] = 0  # an empty slot must be tolerated
        poke(state, mode + 4, struct.pack('<10I', *snapshots))
        ids = [rng.choice([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 14, 15, 200, 255]) for _ in range(12)]
        for pointer, value in zip(snapshots, ids):
            if pointer:
                poke(state, pointer + 0x49B, bytes([value]))
        poke(state, current + 0x49B, bytes([ids[10]]))
        poke(state, user + 0x49F, bytes([ids[11]]))
        state['regs'][0] = mode
        state['regs'][1] = current
        arrived = {}

        def native(machine, name):
            # The native function body: record how it was entered, return a marker.
            arrived[name] = {'regs': [machine.uc.reg_read(r) for r in REGS]}
            ret(machine, 0x1234ABCD)

        def body(name, entry_sp):
            def stub(machine):
                # Reached through the replayed "mov ip, sp": ip must equal sp.
                assert machine.uc.reg_read(reg.UC_ARM_REG_R12) == machine.uc.reg_read(reg.UC_ARM_REG_SP), name + ': ip != sp at the native body'
                native(machine, name)
            return stub
        stubs = {0x5323F018: lambda machine: ret(machine, user)}
        for name, entry in (('load', 0x533E17CC), ('save', 0x533E1C04)):
            stubs_now = dict(stubs)
            stubs_now[entry + 4] = body(name, state['regs'][13])
            before = dict(state)
            after = call(mp, state, entry, stubs_now)
            got = arrived[name]['regs']
            assert got[0] == mode, name + ': r0 not passed on'
            if name == 'load':
                assert got[1:4] == state['regs'][1:4], 'load: arguments not passed on'
                assert after['regs'][0] == 0x1234ABCD, 'load: result not returned'
                assert after['regs'][13] == state['regs'][13], 'load: stack not balanced'
            else:
                # save tail-calls the native function: same stack, returns to the original caller.
                assert got[13] == state['regs'][13] and got[14] == BASE + 0x100000 + 0x4000, 'save: not a clean tail call'
            assert after['regs'][4:12] == state['regs'][4:12], name + ': callee-saved registers changed'
            # Memory: only ratio bytes that are not menu ratios may change, and they become 0.
            expected = {}
            for pointer, value in zip(snapshots, ids):
                if pointer:
                    expected[pointer + 0x49B] = value if value in active else 0
            if name == 'load':
                expected[current + 0x49B] = ids[10] if ids[10] in active else 0
            expected[user + 0x49F] = ids[11] if ids[11] in active else 0
            for address, value in expected.items():
                assert peek(after, address, 1)[0] == value, (name, hex(address), value)
            scrubbed = dict(after)
            scrubbed['regions'] = list(after['regions'])
            for address in expected:
                poke(scrubbed, address, peek(before, address, 1))
            if name == 'save':
                poke(scrubbed, current + 0x49B, peek(before, current + 0x49B, 1))
            assert scrubbed['regions'] == before['regions'], name + ': other memory changed'
            cases += 1
        # User-mode recall: bl 0x5323EA84 became a stub that first normalises [r4 + 0x49F].
        st = dict(state)
        st['regs'] = list(state['regs'])
        st['regs'][4] = user
        seen = {}

        def original_callee(machine):
            seen['regs'] = [machine.uc.reg_read(r) for r in REGS]
            seen['flags'] = machine.uc.reg_read(reg.UC_ARM_REG_CPSR) >> 28
            machine.uc.emu_stop()
            machine.trace_pc = 0x5323EA84
        mp.reset(st)
        mp.stubs = {0x5323EA84: original_callee}
        try:
            mp.uc.emu_start(0x532A90CC, 0xFFFFFFF0, count=4000)
        finally:
            mp.stubs = {}
        assert seen, 'recall: native callee not reached'
        assert seen['regs'][:13] == st['regs'][:13] and seen['regs'][13] == st['regs'][13] and seen['regs'][14] == 0x532A90D0, 'recall: registers'
        assert bytes(mp.uc.mem_read(user + 0x49F, 1))[0] == (ids[11] if ids[11] in active else 0), 'recall: ratio byte'
        cases += 1
    return cases


def check_first_record(patched, custom_count):
    """The enlarged allocation: only for the first record of a map, and of the expected size."""
    mp = Machine(patched)
    rng = random.Random(17)
    for first in (True, False):
        state = random_state(rng)
        state['regs'][10] = REGIONS[0] + 0x1000
        state['regs'][4] = state['regs'][10] + (4 if first else rng.choice([8, 12, 0x30, 0xC4]))
        mp.reset(state)
        problem = mp.run(0x53877334, lambda pc: pc == 0x53877338, limit=64)
        assert not problem, problem
        size = mp.uc.reg_read(reg.UC_ARM_REG_R0)
        assert size == (48 + custom_count * 976 if first else 46), ('record size', first, size)


ASSERT = 0x538ED930  # the firmware's assertion / diagnostic function


def check_raw_development(official, patched, order):
    """In-camera RAW development: for a RAW shot with a factory ratio the old targets are still
    offered, in the old order, with the added ratios after them; code <-> ratio maps agree."""
    mo, mp = Machine(official), Machine(patched)
    rng = random.Random(19)
    state = random_state(rng)
    obj, source = REGIONS[0] + 0x1000, REGIONS[1] + 0x2000
    poke(state, obj + 0x24, struct.pack('<I', source))
    custom = [n for n in order if n >= 4]
    asserted = []
    stubs = {ASSERT: lambda machine: (asserted.append(machine.uc.reg_read(reg.UC_ARM_REG_R0) == 0), ret(machine))[1]}

    def run_call(machine, address, r1, src, current):
        st = dict(state)
        st['regs'] = list(state['regs'])
        st['regions'] = list(state['regions'])
        poke(st, source + 0x7DA, bytes([src]))
        poke(st, obj + 5, bytes([current]))
        st['regs'][0] = obj
        st['regs'][1] = r1
        del asserted[:]
        value = call(machine, st, address, stubs)['regs'][0]
        return value, any(asserted)
    cases = 0
    for src in order:
        for current in (0, 1):
            new_count, failed = run_call(mp, 0x5336B768, 0, src, current)
            assert not failed
            new_list = [run_call(mp, 0x5336B8C4, index, src, current)[0] for index in range(new_count)]
            if src <= 3:
                old_count, failed = run_call(mo, 0x5336B768, 0, src, current)
                assert not failed
                old_list = [run_call(mo, 0x5336B8C4, index, src, current)[0] for index in range(old_count)]
                assert new_list[:old_count] == old_list and all(code >= 5 for code in new_list[old_count:]), ('RAW targets', src, old_list, new_list)
                for code in range(1, 5):
                    old_valid, old_failed = run_call(mo, 0x5336D814, code, src, current)
                    assert not old_failed and run_call(mp, 0x5336D814, code, src, current)[0] == old_valid, ('RAW target validity', src, code)
                # Code 0 ("as shot"). The official validity function reads one byte past its list
                # when the "as shot" entry is offered, so its answer for code 0 depends on padding
                # (0 for a 3:2 source, 1 for the others); the replacement always answers 0. The one
                # caller (0x53375210) then uses the source's own ratio, which is also what code 0
                # maps to in both versions, so the outcome is the same either way:
                old_back, old_failed = run_call(mo, 0x53375088, 0, src, current)
                assert not old_failed and old_back == src and run_call(mp, 0x53375088, 0, src, current)[0] == src, 'code 0 (as shot) must map to the source ratio'
                assert run_call(mp, 0x5336D814, 0, src, current)[0] == 0
            else:
                # An added ratio: "as shot" first when offered, then targets in menu order, itself among them.
                targets = new_list[1:] if current else new_list
                assert (not current) or new_list[0] == 0
                publics = [run_call(mp, 0x53375088, code, src, current)[0] for code in targets]
                positions = [order.index(public) for public in publics]
                assert positions == sorted(positions) and len(set(positions)) == len(positions) and src in publics, ('RAW targets of an added ratio', src, new_list)
            for code in new_list:
                if code:  # code 0 is "as shot": not a re-cut target (the official answer for it is compared above)
                    assert run_call(mp, 0x5336D814, code, src, current)[0] == 1, 'offered target is not valid'
            assert run_call(mp, 0x5336D814, 5 + len(custom), src, current)[0] == 0, 'unknown target accepted'
            cases += 1
    for public in range(4):
        old, failed = run_call(mo, 0x53374D20, public, 0, 0)
        assert not failed and run_call(mp, 0x53374D20, public, 0, 0)[0] == old, 'ratio -> code changed'
        code = old
        old_public, failed = run_call(mo, 0x53375088, code, 0, 0)
        assert not failed and old_public == public and run_call(mp, 0x53375088, code, 0, 0)[0] == public, 'code -> ratio changed'
    for index, public in enumerate(custom):
        assert run_call(mp, 0x53374D20, public, 0, 0)[0] == 5 + index and run_call(mp, 0x53375088, 5 + index, 0, 0)[0] == public, 'added ratio code'
    return cases


def check_entry_wrappers(official, patched, order):
    """Whole-function wrappers: what reaches the native function is what the caller passed."""
    mp = Machine(patched)
    rng = random.Random(23)
    custom = [n for n in order if n >= 4]
    stop = BASE + 0x100000 + 0x4000
    cases = 0
    for trial in range(40):
        # Photo-info rectangle (0x537F6AAC): a factory ratio goes to the native body untouched.
        state = random_state(rng)
        extractor, source = REGIONS[2] + 0x1800, REGIONS[3] + 0x2800
        poke(state, extractor + 8, struct.pack('<I', source))
        poke(state, source + 0x7DA, bytes([trial % 4]))
        state['regs'][0] = extractor
        mp.reset(state)
        problem = mp.run(0x537F6AAC, lambda pc: pc == 0x537F6AB0)
        assert not problem, problem
        now = mp.snapshot()
        # r0 and everything callee-saved as passed; ip = sp as after the native "mov ip, sp".
        # r2 and the flags differ; the native body writes r2 before reading it (0x537F6AC0) and
        # compares before its first conditional instruction.
        assert now['regs'][0] == extractor and now['regs'][4:12] == state['regs'][4:12] and now['regs'][13:] == state['regs'][13:]
        assert now['regs'][1] == state['regs'][1] and now['regs'][3] == state['regs'][3]
        assert now['regs'][12] == now['regs'][13] and now['regions'] == state['regions']
        assert register_dead(official, 0x537F6AB0, 'r2') and flags_dead(official, 0x537F6AB0)

        # Playback classification (bl at 0x536CD414): the native classifier gets the same r0 and
        # its answer goes back to the caller, unless the photo itself carries an added ratio.
        for identity in [0, 1, 2, 3, 4, 5, 6, 99] + custom:
            state = random_state(rng)
            source = REGIONS[1] + 0x2400
            state['regs'][7] = source
            poke(state, source + 0x7DA, bytes([identity]))
            seen = {}

            def classifier(machine):
                seen['r0'] = machine.uc.reg_read(reg.UC_ARM_REG_R0)
                seen['sp'] = machine.uc.reg_read(reg.UC_ARM_REG_SP)
                ret(machine, 0x77)
            mp.reset(state)
            mp.stubs = {0x536C79CC: classifier}
            try:
                problem = mp.run(0x536CD414, lambda pc: pc == 0x536CD418)
            finally:
                mp.stubs = {}
            assert not problem, problem
            now = mp.snapshot()
            assert now['regs'][4:12] == state['regs'][4:12] and now['regs'][13] == state['regs'][13] and now['regions'] == state['regions']
            if identity in custom:
                assert not seen and now['regs'][0] == identity, 'an added ratio stored in a photo must be kept'
            else:
                assert seen['r0'] == state['regs'][0] and now['regs'][0] == 0x77, 'native classification not passed through'
            cases += 1

        # Metering-map copy (0x53877C9C): native copy first, with the caller's arguments, then the
        # appended views are rebuilt for the destination and nothing else is written.
        state = random_state(rng)
        dst, src = REGIONS[0] + 0x1000, REGIONS[1] + 0x1000
        dst_first, src_first = REGIONS[2] + 0x400, REGIONS[3] + 0x400
        poke(state, dst + 4, struct.pack('<I', dst_first))
        poke(state, src + 4, struct.pack('<I', src_first))
        state['regs'][0], state['regs'][1] = dst, src
        seen = {}

        def native_copy(machine):
            seen['regs'] = [machine.uc.reg_read(r) for r in REGS]
            ret(machine, 0x55)
        after = call(mp, state, 0x53877C9C, {0x53877CA0: native_copy}, limit=400000)
        assert seen['regs'][0] == dst and seen['regs'][1] == src and seen['regs'][12] == seen['regs'][13], 'copy: arguments'
        assert after['regs'][4:12] == state['regs'][4:12] and after['regs'][13] == state['regs'][13], 'copy: registers'
        expected = dict(state)
        expected['regions'] = list(state['regions'])
        header = peek(state, dst, 400)
        for n in range(len(custom)):
            a = dst_first + 48 + n * 976
            b = src_first + 48 + n * 976
            view = bytearray(header + peek(state, b + 400, 576))
            for process in range(4):
                for mag in range(3):
                    struct.pack_into('<I', view, 4 * (1 + process * 12 + mag), a + 400 + (process * 3 + mag) * 48)
            poke(expected, a, bytes(view))
        assert after['regions'] == expected['regions'], 'copy: memory differs from the expected view rebuild'
        cases += 1
    return cases


# Build revision 2 (GR Mod 0.3.0), not in the reference: the call in ImageMemory::Alloc that works
# out how many bytes a picture buffer needs goes through appended code that rounds the height up
# to 8 first. It replaces a call, not an instruction, so it is compared the way a call is: at the
# instruction after it, in the registers a callee has to preserve, the result and the memory.
DECODE_BUFFER_CALL = 0x5369ECE8


def check_decode_buffer(official, patched, runs=400, seed=7):
    """mov r1, sb (format) / mov r0, r8 (&{width, height}) / bl CalcImageBufferSize / -> 0x5369ECEC."""
    mo, mp = Machine(official), Machine(patched)
    rng = random.Random(seed)
    after_call = DECODE_BUFFER_CALL + 4
    widths = [16, 160, 720, 1024, 1920, 3504, 4944, 5168, 6192, 16368]
    cases = 0
    for n in range(runs):
        fmt = (1, 3, 4)[n % 3]                       # RGB, YCbCr 4:2:2, YCbCr 4:2:0
        width = rng.choice(widths)
        height = rng.choice([8 * rng.randrange(1, 700), rng.randrange(1, 5600)])
        if n < 8:
            width, height = [(6192, 4128), (4944, 3296), (6192, 3480), (4128, 4128), (4944, 1812), (3504, 1284), (6192, 2580), (1920, 1204)][n]

        def state_for(h):
            state = random_state(random.Random(seed * 7919 + n))
            size = REGIONS[1] + 0x4000
            state['regs'][8] = size
            state['regs'][9] = fmt
            poke(state, size, struct.pack('<II', width, h))
            return state

        results = []
        for machine, h in ((mo, height), (mp, height), (mo, (height + 7) & ~7)):
            state = state_for(h)
            machine.reset(state)
            problem = machine.run(DECODE_BUFFER_CALL - 8, lambda pc: pc == after_call)
            assert problem is None, 'decode buffer call: %s' % problem
            results.append((state, machine.snapshot()))
        (start, off), (_, new), (_, rounded) = results
        where = 'decode buffer call, format %d, %dx%d: ' % (fmt, width, height)
        # the byte count is the official one for the height rounded up to 8 ...
        assert new['regs'][0] == rounded['regs'][0], where + 'r0 %#x, expected %#x' % (new['regs'][0], rounded['regs'][0])
        if fmt != 4:
            expected = width * ((height + 7) & ~7) * (2 if fmt == 3 else 3)
            assert new['regs'][0] == expected, where + 'r0 %d, expected %d' % (new['regs'][0], expected)
        # ... which is the official count itself whenever the height is a multiple of 8
        if height % 8 == 0:
            assert new['regs'][0] == off['regs'][0], where + 'changed a count that needed no change'
        else:
            assert new['regs'][0] > off['regs'][0]
        # everything a caller may rely on after a call is as the official code leaves it
        for index in list(range(4, 12)) + [13]:
            assert new['regs'][index] == off['regs'][index], where + '%s differs' % NAMES[index]
        live = new['regs'][13] - STACK
        assert new['stack'][live:] == off['stack'][live:] == start['stack'][live:], where + 'the stack above sp changed'
        assert new['regions'] == off['regions'] == start['regions'], where + 'memory changed'
        cases += 1
    # what follows the call does not read r1-r3, ip or lr before writing them (mov r1, r0 / mov r2, sl / mov r0, r5 / bl)
    assert [u32(official, after_call + 4 * i) for i in range(3)] == [0xE1A01000, 0xE1A0200A, 0xE1A00005]
    assert u32(official, after_call + 12) >> 24 == 0xEB
    return cases


def run(official, patched, icon_bytes, official_icons, quiet=False):
    official, patched = bytes(official), bytes(patched)
    assert len(official) == OFFICIAL_LEN and len(patched) > OFFICIAL_LEN
    hooks, data = hooks_of(official, patched)
    say = (lambda *a: None) if quiet else print
    say('hooks: %d branch replacements, %d other changed words' % (len(hooks), len(data)))
    if DECODE_BUFFER_CALL in hooks:
        hooks.remove(DECODE_BUFFER_CALL)
        cases = check_decode_buffer(official, patched)
        say('build revision 2, decode buffer size call: %d cases; the count is the official one for the height rounded up to 8, '
            'identical for heights that are multiples of 8; callee-saved registers, stack and memory as after the official call' % cases)
    else:
        say('build revision 1: no decode buffer change')
    unknown = [hex(a) for a in SPECIAL if a not in hooks]
    assert not unknown, 'SPECIAL lists addresses that are not hooks: %s' % unknown
    tested, failures, notes = check_transparent(official, patched, hooks, lead=LEAD)
    for failure in failures:
        say('  NOT TRANSPARENT', failure)
    say('transparent with no added ratio involved: %d hooks, 40 random states each (%d of them leave flags or a scratch register different where the official code overwrites it before reading)' % (tested, len(notes)))
    checked, names, icons = check_directories(official, patched, icon_bytes, official_icons)
    say('text / icon directories: %d lookups identical, %d new name hits, %d new icons' % (checked, names, icons))
    count, order = check_menu(official, patched)
    say('menu: count %d, order %s; validator, names, icons and Fn cycling as expected' % (count, order))
    cases = check_settings(official, patched, order)
    say('settings save / load / recall wrappers: %d cases' % cases)
    check_first_record(patched, count - 4)
    say('first-record allocation: enlarged only for the first record')
    cases = check_raw_development(official, patched, order)
    say('RAW development targets and code maps: %d source / option combinations' % cases)
    cases = check_entry_wrappers(official, patched, order)
    say('photo-info, playback classification and metering-map copy wrappers: %d cases' % cases)
    if failures:
        raise SystemExit('transparency check failed')
    return {'hooks': len(hooks), 'transparent': tested, 'entry_level': sorted(a for a, v in SPECIAL.items() if v == 'entry')}


if __name__ == '__main__':
    import common
    official = common.image()
    patched = open(sys.argv[1], 'rb').read()
    icons = open(sys.argv[2], 'rb').read() if len(sys.argv) > 2 else official.icon_bytes + bytes(9600 * 8)
    run(official.rtos, patched, icons, official.icon_bytes)
