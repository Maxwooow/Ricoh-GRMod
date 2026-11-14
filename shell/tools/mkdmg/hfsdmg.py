#!/usr/bin/env python3
"""
Write an HFS+ volume and a compressed disk image (UDIF, .dmg) in pure Python.

mkdmg.py uses this when the libdmg-hfsplus tools (hfsplus, dmg) are not on PATH. Only what an
app's disk image needs: folders, regular files (data fork only, permission bits kept),
symbolic links and the window layout file; no resource forks, extended attributes or hard links.

    from hfsdmg import build_hfs, write_udif
    image = build_hfs(stage_dir, 'GR Mod 0.8.11')      # bytes of the HFS+ volume
    write_udif(image, 'GRMod-0.8.11-mac.dmg')          # partition map + zlib chunks + koly

The layout of the disk image (driver descriptor, Apple partition map, an empty ATAPI driver
partition, the volume, a short free partition) is the one libdmg-hfsplus writes, which the
earlier GR Mod disk images use.

References: Apple TN1150 (HFS Plus Volume Format); the UDIF trailer and block tables as
documented by the libdmg-hfsplus sources and "Demystifying the DMG file format" (J. Levin).
"""
import binascii, os, plistlib, stat, struct, time, uuid, zlib

BLOCK = 4096
CAT_NODE = 4096
EXT_NODE = 4096
ATTR_NODE = 8192
HFS_EPOCH = 2082844800          # seconds from 1904-01-01 to 1970-01-01

ROOT_PARENT, ROOT_ID, FIRST_ID = 1, 2, 16
FOLDER_REC, FILE_REC, FOLDER_THREAD, FILE_THREAD = 1, 2, 3, 4


def hfs_time(t):
    return (int(t) + HFS_EPOCH) & 0xFFFFFFFF


# --- name ordering: HFS+ case-insensitive comparison (FastUnicodeCompare) -------------------
# Only the part of Apple's case folding table that matters for the names written here is
# needed: names are checked to be printable ASCII (see check_name), where folding is A-Z -> a-z.

def check_name(name):
    if not name or len(name) > 255 or any(not (0x20 <= ord(c) < 0x7F) for c in name) or '/' in name and name != '/':
        raise ValueError(f'hfsdmg: unsupported file name {name!r} (printable ASCII only)')


def fold(name):
    return [ord(c) + 32 if 'A' <= c <= 'Z' else ord(c) for c in name]


def cat_key_order(parent, name):
    return (parent, fold(name))


# --- catalog records ------------------------------------------------------------------------

def uni(name):
    return struct.pack('>H', len(name)) + name.encode('utf-16-be')


def cat_key(parent, name):
    body = struct.pack('>I', parent) + uni(name)
    return struct.pack('>H', len(body)) + body


def bsd(mode, owner=99, group=99):
    # ownerID, groupID, adminFlags, ownerFlags, fileMode, special
    return struct.pack('>IIBBHI', owner, group, 0, 0, mode, 0)


def fork(logical, start, count):
    ext = struct.pack('>II', start, count) if count else b''
    return struct.pack('>QII', logical, 0, count) + ext.ljust(64, b'\0')


def folder_record(fid, valence, mode, t):
    rec = struct.pack('>hHII', FOLDER_REC, 0, valence, fid)
    rec += struct.pack('>5I', t, t, t, t, 0)
    rec += bsd(mode)
    rec += bytes(16) + bytes(16)                     # FolderInfo, ExtendedFolderInfo
    rec += struct.pack('>II', 0, 0)                  # textEncoding, reserved
    assert len(rec) == 88
    return rec


def file_record(fid, mode, t, data_fork, ftype=b'\0' * 4, creator=b'\0' * 4):
    rec = struct.pack('>hHII', FILE_REC, 0x0002, 0, fid)   # kHFSThreadExistsMask
    rec += struct.pack('>5I', t, t, t, t, 0)
    rec += bsd(mode)
    rec += ftype + creator + bytes(8)                # FileInfo
    rec += bytes(16)                                 # ExtendedFileInfo
    rec += struct.pack('>II', 0, 0)
    rec += data_fork + fork(0, 0, 0)                 # data, resource
    assert len(rec) == 248
    return rec


def thread_record(kind, parent, name):
    return struct.pack('>hhI', kind, 0, parent) + uni(name)


# --- B-trees --------------------------------------------------------------------------------

def node_bytes(size, flink, blink, kind, height, records):
    body = b''.join(records)
    offsets = [14]
    for r in records:
        offsets.append(offsets[-1] + len(r))
    if 14 + len(body) + 2 * len(offsets) > size:
        raise ValueError('hfsdmg: B-tree node overflow')
    n = struct.pack('>IIbBHH', flink, blink, kind, height, len(records), 0) + body
    n = n.ljust(size - 2 * len(offsets), b'\0')
    n += b''.join(struct.pack('>H', o) for o in reversed(offsets))
    assert len(n) == size
    return n


def header_node(size, total, used, depth, root, leaf_records, first_leaf, last_leaf, max_key, compare, attrs, clump):
    hdr = struct.pack('>HIIIIHHIIHIBBI', depth, root, leaf_records, first_leaf, last_leaf, size, max_key,
                      total, total - used, 0, clump, 0, compare, attrs) + bytes(64)
    assert len(hdr) == 106
    user = bytes(128)
    map_len = size - 14 - 106 - 128 - 8
    if total > map_len * 8:
        raise ValueError('hfsdmg: B-tree too large for the header map')
    bits = bytearray(map_len)
    for i in range(used):
        bits[i >> 3] |= 0x80 >> (i & 7)
    return node_bytes(size, 0, 0, 1, 0, [hdr, user, bytes(bits)])


def build_tree(records, size, total, max_key, compare, attrs, clump):
    """records: sorted list of (key bytes, data bytes). Returns the tree file (total nodes)."""
    leaves, cur, cur_len = [], [], 0
    for k, v in records:
        r = k + v
        if len(r) % 2:
            r += b'\0'
        if cur and 14 + cur_len + len(r) + 2 * (len(cur) + 2) > size:
            leaves.append(cur)
            cur, cur_len = [], 0
        cur.append((k, r))
        cur_len += len(r)
    if cur:
        leaves.append(cur)
    nodes = [None]                                   # node 0: header
    if not leaves:
        nodes[0] = header_node(size, total, 1, 0, 0, 0, 0, 0, max_key, compare, attrs, clump)
        return nodes[0] + bytes(size * (total - 1))
    first = 1
    level = []
    for i, leaf in enumerate(leaves):
        no = first + i
        flink = no + 1 if i + 1 < len(leaves) else 0
        blink = no - 1 if i else 0
        nodes.append(node_bytes(size, flink, blink, -1, 1, [r for _, r in leaf]))
        level.append((leaf[0][0], no))
    depth = 1
    while len(level) > 1:                            # index levels (variable-length keys)
        depth += 1
        nxt, cur, cur_len, start = [], [], 0, len(nodes)
        groups = []
        for k, child in level:
            r = k + struct.pack('>I', child)
            if cur and 14 + cur_len + len(r) + 2 * (len(cur) + 2) > size:
                groups.append(cur)
                cur, cur_len = [], 0
            cur.append((k, r))
            cur_len += len(r)
        groups.append(cur)
        for i, g in enumerate(groups):
            no = start + i
            flink = no + 1 if i + 1 < len(groups) else 0
            blink = no - 1 if i else 0
            nodes.append(node_bytes(size, flink, blink, 0, depth, [r for _, r in g]))
            nxt.append((g[0][0], no))
        level = nxt
    used = len(nodes)
    if used > total:
        raise ValueError('hfsdmg: catalog larger than its file')
    nodes[0] = header_node(size, total, used, depth, level[0][1], len(records), 1, len(leaves),
                           max_key, compare, attrs, clump)
    return b''.join(nodes) + bytes(size * (total - used))


# --- the volume -----------------------------------------------------------------------------

def build_hfs(src, volname, now=None):
    """The HFS+ volume holding the contents of folder src (its files, folders, symlinks)."""
    check_name(volname.replace(':', ' ')) if volname else None
    now = hfs_time(now if now is not None else time.time())
    entries = []                                     # (parent id, name, kind, id, payload, mode)
    next_id = [FIRST_ID]

    def walk(path, fid):
        names = sorted(os.listdir(path), key=lambda n: fold(n))
        count = 0
        for name in names:
            check_name(name)
            p = os.path.join(path, name)
            st = os.lstat(p)
            cid = next_id[0]
            next_id[0] += 1
            count += 1
            if stat.S_ISLNK(st.st_mode):
                entries.append((fid, name, 'link', cid, os.readlink(p).encode('utf-8'), 0o120755))
            elif stat.S_ISDIR(st.st_mode):
                idx = len(entries)
                entries.append(None)
                valence = walk(p, cid)
                entries[idx] = (fid, name, 'dir', cid, valence, 0o40000 | (st.st_mode & 0o7777))
            elif stat.S_ISREG(st.st_mode):
                with open(p, 'rb') as f:
                    entries.append((fid, name, 'file', cid, f.read(), 0o100000 | (st.st_mode & 0o7777)))
            else:
                raise ValueError(f'hfsdmg: {p}: not a file, folder or symlink')
        return count

    root_valence = walk(src, ROOT_ID)

    blocks_for = lambda n: (n + BLOCK - 1) // BLOCK
    data_blocks = sum(blocks_for(len(e[4])) for e in entries if e[2] in ('file', 'link'))
    ext_nodes, attr_nodes = 4, 2
    cat_nodes = 8 + 2 * len(entries) * 300 // CAT_NODE
    ext_blocks = ext_nodes * EXT_NODE // BLOCK
    cat_blocks = cat_nodes * CAT_NODE // BLOCK
    attr_blocks = attr_nodes * ATTR_NODE // BLOCK
    meta = 1 + ext_blocks + cat_blocks + attr_blocks + 1          # + volume header, alternate
    total = meta + data_blocks + 256                              # a little free space (1 MB)
    for _ in range(3):                                            # the bitmap's own size
        bitmap_blocks = blocks_for((total + 7) // 8)
        total = meta + bitmap_blocks + data_blocks + 256
    total = (total + 7) // 8 * 8

    img = bytearray(total * BLOCK)
    used = bytearray(total)
    nxt = 0

    def alloc(n):
        nonlocal nxt
        start = nxt
        for i in range(start, start + n):
            used[i] = 1
        nxt += n
        return start

    alloc(1)                                                      # boot blocks + volume header
    bitmap_start = alloc(bitmap_blocks)
    ext_start = alloc(ext_blocks)
    cat_start = alloc(cat_blocks)
    attr_start = alloc(attr_blocks)
    used[total - 1] = 1                                           # alternate volume header

    records = []
    files = folders = 0
    records.append((cat_key(ROOT_PARENT, volname), folder_record(ROOT_ID, root_valence, 0o40755, now)))
    records.append((cat_key(ROOT_ID, ''), thread_record(FOLDER_THREAD, ROOT_PARENT, volname)))
    for parent, name, kind, cid, payload, mode in entries:
        if kind == 'dir':
            folders += 1
            records.append((cat_key(parent, name), folder_record(cid, payload, mode, now)))
            records.append((cat_key(cid, ''), thread_record(FOLDER_THREAD, parent, name)))
            continue
        files += 1
        n = blocks_for(len(payload))
        start = alloc(n) if n else 0
        img[start * BLOCK:start * BLOCK + len(payload)] = payload
        ftype, creator = (b'slnk', b'rhap') if kind == 'link' else (b'\0' * 4, b'\0' * 4)
        records.append((cat_key(parent, name), file_record(cid, mode, now, fork(len(payload), start, n), ftype, creator)))
        records.append((cat_key(cid, ''), thread_record(FILE_THREAD, parent, name)))
    order = {}
    for k, v in records:
        parent = struct.unpack('>I', k[2:6])[0]
        nl = struct.unpack('>H', k[6:8])[0]
        name = k[8:8 + 2 * nl].decode('utf-16-be')
        order[k] = cat_key_order(parent, name)
    records.sort(key=lambda kv: order[kv[0]])
    keys = [order[k] for k, _ in records]
    assert len(set(map(lambda x: (x[0], tuple(x[1])), keys))) == len(keys), 'hfsdmg: duplicate names'

    cat = build_tree(records, CAT_NODE, cat_nodes, 516, 0xCF, 6, cat_blocks * BLOCK)
    ext = build_tree([], EXT_NODE, ext_nodes, 10, 0, 2, ext_blocks * BLOCK)
    attr = build_tree([], ATTR_NODE, attr_nodes, 266, 0, 6, attr_blocks * BLOCK)
    img[ext_start * BLOCK:ext_start * BLOCK + len(ext)] = ext
    img[cat_start * BLOCK:cat_start * BLOCK + len(cat)] = cat
    img[attr_start * BLOCK:attr_start * BLOCK + len(attr)] = attr

    bitmap = bytearray(bitmap_blocks * BLOCK)
    for i in range(total):
        if used[i]:
            bitmap[i >> 3] |= 0x80 >> (i & 7)
    img[bitmap_start * BLOCK:bitmap_start * BLOCK + len(bitmap)] = bitmap
    free = total - sum(used)

    vid = uuid.uuid4().bytes[:8]
    vh = struct.pack('>2sHIIIIIIIIIIIIIIIII', b'H+', 4, 0x80000100, 0x31302E30, 0,
                     now, now, 0, now, files, folders, BLOCK, total, free, nxt, 65536, 65536,
                     next_id[0], 1)
    vh += struct.pack('>Q', 1)                                    # encodings: MacRoman
    vh += struct.pack('>8I', 0, 0, ROOT_ID, 0, 0, 0, 0, 0)[:24] + vid   # finderInfo: open the root window
    vh += fork(len(bitmap), bitmap_start, bitmap_blocks)
    vh += fork(len(ext), ext_start, ext_blocks)
    vh += fork(len(cat), cat_start, cat_blocks)
    vh += fork(len(attr), attr_start, attr_blocks)
    vh += fork(0, 0, 0)
    assert len(vh) == 512, len(vh)
    # clump sizes of the special files = their sizes
    vh = bytearray(vh)
    for i, size in enumerate((len(bitmap), len(ext), len(cat), len(attr))):
        struct.pack_into('>I', vh, 112 + 80 * i + 8, size)
    img[1024:1536] = vh
    img[len(img) - 1024:len(img) - 512] = vh
    return bytes(img)


# --- the disk image (UDIF) ------------------------------------------------------------------

SECTOR = 512
CHUNK = 512                     # sectors per compressed chunk (as hdiutil and libdmg)
PLST = bytes(0x204) + b'\x00\x01\x00\x01' + bytes(0x408 - 0x208)   # as libdmg-hfsplus writes it


def partition_entry(start, count, name, ptype, status, total=4, data=None, extra=b''):
    e = struct.pack('>2sHIII32s32sIIII', b'PM', 0, total, start, count, name, ptype, 0,
                    count if data is None else data, status, 0)
    return (e + extra).ljust(SECTOR, b'\0')


def disk(volume):
    """Driver descriptor, partition map (63 sectors), ATAPI driver (8), the volume, free (10)."""
    vol_sectors = len(volume) // SECTOR
    total = 72 + vol_sectors + 10
    ddm = struct.pack('>2sHI', b'ER', SECTOR, total).ljust(SECTOR, b'\0')
    pm = partition_entry(1, 63, b'Apple', b'Apple_partition_map', 3)
    pm += partition_entry(64, 8, b'Macintosh', b'Apple_Driver_ATAPI', 0x303,
                          extra=bytes.fromhex('0000000000000800000000000000000000000000000000000000ffff00000000000000000000000000000000594d4d44'))
    pm += partition_entry(72, vol_sectors, b'Mac_OS_X', b'Apple_HFS', 0x40000033)
    pm += partition_entry(72 + vol_sectors, 10, b'', b'Apple_Free', 0, data=0)
    pm = pm.ljust(63 * SECTOR, b'\0')
    parts = [
        ('Driver Descriptor Map (DDM : 0)', -1, 0, ddm),
        ('Apple (Apple_partition_map : 1)', 0, 1, pm),
        ('Macintosh (Apple_Driver_ATAPI : 2)', 1, 64, bytes(8 * SECTOR)),
        ('Mac_OS_X (Apple_HFS : 3)', 2, 72, volume),
        (' (Apple_Free : 4)', 3, 72 + vol_sectors, None),
    ]
    return parts, total


def write_udif(volume, out):
    assert len(volume) % SECTOR == 0
    parts, total = disk(volume)
    data = bytearray()
    blkx = []
    for name, pid, first, content in parts:
        chunks = []
        if content is None:
            count = 10
            chunks.append((2, 0, count, len(data), 0))
            crc = 0
        else:
            count = len(content) // SECTOR
            crc = binascii.crc32(content)
            for s in range(0, count, CHUNK):
                n = min(CHUNK, count - s)
                raw = content[s * SECTOR:(s + n) * SECTOR]
                z = zlib.compress(raw, 9)
                if len(z) < len(raw):
                    chunks.append((0x80000005, s, n, len(data), len(z)))
                    data += z
                else:
                    chunks.append((1, s, n, len(data), len(raw)))
                    data += raw
        mish = struct.pack('>4sIQQQII', b'mish', 1, first, count, 0, 520 if content is not None else 0, pid & 0xFFFFFFFF)
        mish += bytes(24)
        mish += struct.pack('>II', 2, 32) + struct.pack('>I', crc) + bytes(124)
        mish += struct.pack('>I', len(chunks) + 1)
        for t, s, n, off, ln in chunks:
            mish += struct.pack('>IIQQQQ', t, 0, s, n, off, ln)
        mish += struct.pack('>IIQQQQ', 0xFFFFFFFF, 0, count, 0, len(data), 0)
        blkx.append({'Attributes': '0x0050', 'CFName': name, 'Data': mish, 'ID': str(pid), 'Name': name})
    master = binascii.crc32(b''.join(struct.pack('>I', struct.unpack('>I', b['Data'][72:76])[0]) for b in blkx))
    xml = plistlib.dumps({'resource-fork': {
        'blkx': blkx,
        'plst': [{'Attributes': '0x0050', 'Data': PLST, 'ID': '0', 'Name': ''}],
    }})
    xml_off = len(data)
    data_crc = binascii.crc32(data)
    koly = struct.pack('>4sIIIQQQQQIi16s', b'koly', 4, 512, 1, 0, 0, len(data), 0, 0, 1, 1, uuid.uuid4().bytes)
    koly += struct.pack('>II', 2, 32) + struct.pack('>I', data_crc) + bytes(124)
    koly += struct.pack('>QQ', xml_off, len(xml)) + bytes(120)
    koly += struct.pack('>II', 2, 32) + struct.pack('>I', master) + bytes(124)
    koly += struct.pack('>IQ', 1, total) + bytes(12)
    assert len(koly) == 512, len(koly)
    with open(out, 'wb') as f:
        f.write(data)
        f.write(xml)
        f.write(koly)
