# Byte patch between two files: ops COPY(old offset, length) / ADD(literal bytes), zlib-deflated.
# Format (before deflate): b'GRMP1' u32 newLen, then ops: 0x01 u32 off u32 len | 0x02 u32 len bytes ; ends 0x00.
import sys, struct, zlib, hashlib
B = 32
def make(old, new):
    idx = {}
    for o in range(0, len(old) - B + 1, B):
        idx.setdefault(old[o:o + B], o)
    out = bytearray(b'GRMP1' + struct.pack('<I', len(new)))
    lit = bytearray(); i = 0; n = len(new)
    def flush():
        if lit:
            out.extend(b'\x02' + struct.pack('<I', len(lit)) + lit); lit.clear()
    while i < n:
        o = idx.get(new[i:i + B]) if i + B <= n else None
        if o is None:
            lit.append(new[i]); i += 1; continue
        # extend backwards into the pending literal
        back = 0
        while back < len(lit) and o - back - 1 >= 0 and old[o - back - 1] == lit[len(lit) - back - 1]: back += 1
        if back: del lit[len(lit) - back:]
        s_old = o - back; s_new = i - back
        # extend forwards in big steps
        L = B + back
        step = 1 << 16
        while True:
            a = old[s_old + L:s_old + L + step]; b = new[s_new + L:s_new + L + step]
            if a == b and len(a) == step: L += step; continue
            m = 0; k = min(len(a), len(b))
            while m < k and a[m] == b[m]: m += 1
            L += m; break
        flush()
        out.extend(b'\x01' + struct.pack('<II', s_old, L))
        i = s_new + L
    flush(); out.append(0)
    return zlib.compress(bytes(out), 9)
def apply(old, p):
    d = zlib.decompress(p); assert d[:5] == b'GRMP1'
    n = struct.unpack('<I', d[5:9])[0]; out = bytearray(); j = 9
    while d[j]:
        if d[j] == 1:
            o, L = struct.unpack('<II', d[j + 1:j + 9]); out += old[o:o + L]; j += 9
        else:
            L = struct.unpack('<I', d[j + 1:j + 5])[0]; out += d[j + 5:j + 5 + L]; j += 5 + L
    assert len(out) == n
    return bytes(out)
if __name__ == '__main__':
    a = open(sys.argv[1], 'rb').read(); b = open(sys.argv[2], 'rb').read()
    p = make(a, b); assert apply(a, p) == b
    open(sys.argv[3], 'wb').write(p)
    print(sys.argv[3], len(p), hashlib.sha256(b).hexdigest())
