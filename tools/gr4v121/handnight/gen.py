# SPDX-License-Identifier: GPL-2.0-only
"""Compile mfmod.c (with c/mf_core.c and c/night_tone.c) for the camera (ARMv7-A, ARM mode, NEON, soft-float calls) and write
core/src/fw/gr4v121/aspect/handnight-code.ts: the module and its data (the reciprocal table of ref.py, the noise slope
per Sv step).  Checks as tools/gr4v121/flash/ttl/gen.py: identical when linked at two addresses (position independent),
no .data / .bss / .rodata / .got, no undefined symbol (no library calls), entry `mfmod` at offset 0, soft-float calling
convention (ELF attribute Tag_ABI_VFP_args = 0); prints the stack use.  (As tools/gr4v121/videoaf/gen.py.)
Needs `python -m ziglang`."""
import base64, hashlib, math, os, struct, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = ROOT / 'core' / 'src' / 'fw' / 'gr4v121' / 'aspect'
CORE = HERE / 'c'
Z = [sys.executable, '-m', 'ziglang']
# NEON build: zig's arm-freestanding-eabi implies soft float without NEON,
# so the target is eabihf with -mfloat-abi=softfp: NEON/VFP instructions, soft-float calling convention (float arguments in
# core registers; the module's interface has none), so the soft-float firmware calls it unchanged.  The camera kernel saves
# d0-d31/FPSCR per task (the research notes T7b.4).  build() checks Tag_ABI_VFP_args = base AAPCS.
FLAGS = ['-std=c99', '-target', 'arm-freestanding-eabihf', '-mcpu=cortex_a7', '-marm', '-mfloat-abi=softfp', '-mfpu=neon-vfpv4', '-O2', '-fomit-frame-pointer',
         '-ffreestanding', '-fno-builtin', '-fno-unwind-tables', '-fno-asynchronous-unwind-tables', '-nostdlib', '-fropi', '-frwpi',
         '-fno-jump-tables', '-Wall', '-Wextra', '-Werror', '-fstack-usage']

# data (keep in sync with mfmod.c)
# The noise slope table (per ISO step, from the camera's own nominal ISO table) is made by the installer from the image:
# core/src/fw/gr4v121/aspect/handnight.ts, noiseSlopes(); ns_table() below is the same formula for the tests.
NS_FIRST, NS_LAST = 0, 51
K = 1024.0 ** 2 / math.pi             # ref.noise_table: entry = round(256 * 2 sqrt(4 var / pi)) = round(sqrt(K var))
LR = 1e-8                             # noisecal: read-noise floor (normalised)
def lam_s(iso): return 1.24e-6 * iso ** 0.71   # the noise fit measured on GR IV bursts
def ns_table(isos):
    return [int(round(K * lam_s(iso) * 65536)) for iso in isos]
NS_B = int(round(K * LR * 65536))
def rcp_table():                      # ref.RCP
    return [0] + [((1 << 24) + d // 2) // d for d in range(1, 64 * 8 + 1)]


def run(cmd):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True)
    if r.returncode: sys.exit(' '.join(map(str, cmd)) + '\n' + r.stdout + r.stderr)
    return r.stdout


def elf32(d):
    assert d[:6] == b'\x7fELF\x01\x01'
    shoff, = struct.unpack_from('<I', d, 0x20); shentsize, shnum, shstrndx = struct.unpack_from('<3H', d, 0x2e)
    sh = [struct.unpack_from('<10I', d, shoff + i * shentsize) for i in range(shnum)]
    text = lambda tab, off: d[tab + off:d.index(b'\0', tab + off)].decode()
    sections = {text(sh[shstrndx][4], s[0]): s[5] for s in sh}
    symbols = {}
    for s in sh:
        if s[1] == 2:
            for o in range(s[4], s[4] + s[5], 16):
                name, value, _, info, _, shndx = struct.unpack_from('<IIIBBH', d, o)
                if info & 15 in (0, 1, 2) and name: symbols[text(sh[s[6]][4], name)] = (value, shndx != 0)
    return sections, symbols


def vfp_args(d):
    """Tag_ABI_VFP_args (28) of the 'aeabi' subsection of .ARM.attributes (absent = 0, base AAPCS)."""
    shoff, = struct.unpack_from('<I', d, 0x20); shentsize, shnum, shstrndx = struct.unpack_from('<3H', d, 0x2e)
    sh = [struct.unpack_from('<10I', d, shoff + i * shentsize) for i in range(shnum)]
    name = lambda s: d[sh[shstrndx][4] + s[0]:d.index(b'\0', sh[shstrndx][4] + s[0])].decode()
    a = next((d[s[4]:s[4] + s[5]] for s in sh if name(s) == '.ARM.attributes'), None)
    if not a: return 0
    assert a[0:1] == b'A'
    def uleb(b, i):
        v = sh_ = 0
        while True:
            c = b[i]; i += 1; v |= (c & 127) << sh_; sh_ += 7
            if c < 128: return v, i
    i = 1
    while i < len(a):
        ln, = struct.unpack_from('<I', a, i); sub = a[i + 4:i + ln]; i += ln
        vendor = sub[:sub.index(b'\0')]; j = len(vendor) + 1
        if vendor != b'aeabi': continue
        while j < len(sub):
            tag = sub[j]; sz, = struct.unpack_from('<I', sub, j + 1); body = sub[j + 5:j + sz]; j += sz
            if tag != 1: continue                     # file attributes only
            k = 0
            while k < len(body):
                t, k = uleb(body, k)
                if t in (4, 5, 67):                   # NTBS-valued tags
                    k = body.index(b'\0', k) + 1
                elif t == 32:                         # Tag_compatibility: uleb + NTBS
                    _, k = uleb(body, k); k = body.index(b'\0', k) + 1
                else:
                    v, k = uleb(body, k)
                    if t == 28: return v
    return 0


def build(extra=()):
    os.environ.setdefault('ZIG_GLOBAL_CACHE_DIR', os.path.join(tempfile.gettempdir(), 'zigg')); os.environ.setdefault('ZIG_LOCAL_CACHE_DIR', os.path.join(tempfile.gettempdir(), 'zigl'))
    with tempfile.TemporaryDirectory() as t:
        t = Path(t); obj = t / 'mfmod.o'
        run(Z + ['cc'] + FLAGS + list(extra) + ['-c', HERE / 'mfmod.c', '-o', obj])
        su = (t / 'mfmod.su').read_text() if (t / 'mfmod.su').exists() else ''
        if vfp_args(obj.read_bytes()) != 0: sys.exit('module does not use the soft-float calling convention')
        outs = []
        for origin in (0x10000, 0x54430000):
            elf = t / f'a{origin:x}.elf'
            run(Z + ['ld.lld', f'-Ttext=0x{origin:x}', '--entry=mfmod', '-o', elf, obj])
            run(Z + ['objcopy', '-O', 'binary', '-j', '.text', elf, t / 'a.bin'])
            outs.append((t / 'a.bin').read_bytes())
            sections, symbols = elf32(elf.read_bytes())
            for name, size in sections.items():
                if size and name.split('.')[1:2] and name.split('.')[1] in ('data', 'bss', 'rodata', 'got'): sys.exit(f'module has a {name} section')
            if symbols.get('mfmod') != (origin, True): sys.exit('mfmod is not at the start of .text')
            if any(not defined for n, (_, defined) in symbols.items() if n): sys.exit('undefined symbols: ' + ', '.join(n for n, (_, d) in symbols.items() if n and not d))
        if outs[0] != outs[1]: sys.exit('not position independent')
        return outs[0] + b'\0' * (-len(outs[0]) % 4), su


def main():
    # extra -DNAME=VALUE arguments: a variant build of the switches mfmod.c guards with #ifndef (tests' reference builds only)
    extra = [a for a in sys.argv[1:] if a.startswith('-D')]
    code, su = build(extra)
    rcp = rcp_table()
    assert len(rcp) == 513
    data = struct.pack(f'<{len(rcp)}i', *rcp)
    src = hashlib.sha256(b''.join((HERE / n).read_bytes() for n in ('mfmod.c', 'c/mf_core.c', 'c/mf_core.h', 'c/night_tone.c', 'c/night_tone.h'))).hexdigest()
    stack = max((int(l.split('\t')[1]) for l in su.splitlines() if l.strip()), default=0)
    import re
    src_c = (HERE / 'mfmod.c').read_text()
    def switch(name):                 # the build's value of an #ifndef-guarded switch (-DNAME=V or the default in mfmod.c)
        for x in extra:
            if x.startswith(f'-D{name}='): return int(x.split('=', 1)[1], 0)
        m = re.search(rf'#ifndef {name}\n#define {name} (\d+)', src_c)
        return int(m.group(1)) if m else 0
    (OUT / 'handnight-code.ts').write_text(
        '// SPDX-License-Identifier: GPL-2.0-only\n'
        '// GENERATED by tools/gr4v121/handnight/gen.py from mfmod.c, c/mf_core.c and c/night_tone.c -- do not edit.\n'
        f'// Source SHA-256: {src}\n'
        '// Position independent; entry `mfmod(ctx, which, a, b, e)` at offset 0; ctx layout: struct ctx in mfmod.c.\n'
        f'// Largest stack frame of one function: {stack} bytes.\n\n'
        f"export const MF_CODE = '{base64.b64encode(code).decode()}';\n"
        f'export const MF_CODE_LENGTH = {len(code)};\n'
        '/** RCP (513 int32, ref.py). */\n'
        f"export const MF_DATA = '{base64.b64encode(data).decode()}';\n"
        f'export const MF_RCP_WORDS = {len(rcp)};\n'
        f'export const MF_NS_WORDS = {NS_LAST - NS_FIRST + 1};\n'
        f'export const MF_NS_B = {NS_B};\n'
        '/** The module\'s PROBES and PROGRESS_BAR switches (handnight.ts draws the bar to match; PROBES must be 0). */\n'
        f'export const MF_PROBES = {switch("PROBES")};\n'
        f'export const MF_PBAR = {switch("PROGRESS_BAR")};\n'
        '/** The PROC_TEXT switch (handnight.ts draws the processing screen\'s text line to match; the module does not use it). */\n'
        f'export const MF_PTEXT = {switch("PROC_TEXT")};\n')
    print(f'module {len(code)} bytes, data {len(data)} bytes, largest stack frame {stack} bytes')
    print(su)


if __name__ == '__main__':
    main()
