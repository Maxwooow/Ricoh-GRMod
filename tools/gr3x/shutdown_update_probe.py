"""Execute IIIx resource-update routing and shutdown JPEG selection on ARM.

Filesystem, allocation, mutex and app-context services are controlled fixtures.
The resource skip branch, write permission, create/retry logic, shutdown edition
selection, JPEG descriptors and request setters execute the native instructions.
No camera, flash or display I/O is performed.
"""
import hashlib
import struct
from unicorn import arm_const as reg
from native_probe import NativeProbe, BASE, OBJECT, OUTPUT, STACK, STOP, MUTEX

RESOURCE_WRITER = 0x5362a224
BACKGROUND = 0x5319f180
JPEG_REQUEST = 0x5322e4a8
RESOURCE = 0x62020000
HEAP_OBJECT, VTABLE, ALLOC, FREE = 0x62040000, 0x62041000, 0x62080000, 0x62080004
HEAP, RECORDS = 0x63000000, 0x64000000
SYS, APP, GEOMETRY, DISPLAY = 0x62050000, 0x62060000, 0x62061000, 0x62062000
NEW_PATH = 'A:\\GR20J2.JPG'
OLD_PATH = 'B:\\Resource\\Jpeg\\GoodBye.jpg'


def put(cpu, at, value):
    cpu.mem_write(at, struct.pack('<I', value))


def u32(cpu, at):
    return struct.unpack('<I', cpu.mem_read(at, 4))[0]


def string(cpu, at):
    data = bytes(cpu.mem_read(at, 128))
    assert b'\0' in data
    return data.split(b'\0')[0].decode('ascii')


def overlay(probe, candidate):
    old_end = (len(probe.data) + 4095) & ~4095
    new_end = (len(candidate) + 4095) & ~4095
    assert new_end >= old_end and BASE + new_end < 0x55000000
    if new_end > old_end:
        probe.uc.mem_map(BASE + old_end, new_end - old_end)
    probe.uc.mem_write(BASE, candidate)
    src, dst, size = struct.unpack_from('<3I', candidate, 0x450)
    assert (src, dst, size) == (0x5407b540, 0x55000000, 0x3a080)
    probe.uc.mem_write(dst, candidate[src - BASE:src - BASE + size])


class ResourceProbe(NativeProbe):
    def __init__(self, data, candidate):
        self.writes, self.mounts, self.allocations = [], [], []
        self.section_headers = []
        self.fail_mount, self.live_size = None, None
        super().__init__(data)
        overlay(self, candidate)
        self.uc.mem_map(HEAP, 0x800000)
        self.uc.mem_map(RECORDS, 0x800000)
        put(self.uc, OBJECT + 4, HEAP_OBJECT)
        put(self.uc, OBJECT + 0xc, RESOURCE)
        put(self.uc, HEAP_OBJECT, VTABLE)
        put(self.uc, VTABLE + 8, ALLOC)
        put(self.uc, VTABLE + 12, FREE)
        # Native updater enables writing to the resource drives.
        self.uc.mem_write(RESOURCE + 0x44, b'\x01')

    def _hook(self, cpu, at, size, user):
        result = None
        args = lambda: [cpu.reg_read(getattr(reg, 'UC_ARM_REG_R' + str(i))) for i in range(4)]
        if at == 0x536b82d4:
            result = 0
        elif at == 0x5362a51c:
            address = cpu.reg_read(reg.UC_ARM_REG_R5)
            self.section_headers.append(list(struct.unpack('<4I', cpu.mem_read(address, 16))))
        elif at in (0x5362b110, 0x537fb2d0, 0x5362ae80, 0x53629e60,
                    0x53629b5c, 0x53629bcc, 0x53629cc4, 0x5362a468, 0x5362b120):
            # Outer update lifecycle, bank/format/finalization and progress I/O.
            # The section walk and the full native RES writer are not stubbed.
            result = 1
        elif at in MUTEX:
            result = 1
        elif at == 0x5362d65c:
            _, name, _, _ = args()
            drive = string(cpu, name)
            self.mounts.append(drive)
            result = int(drive != self.fail_mount)
        elif at == ALLOC:
            _, length, _, _ = args()
            assert self.live_size is None and 0 < length < 0x7fff00
            self.live_size = length
            cpu.mem_write(HEAP, b'\xa5' * (length + 32))
            self.allocations.append(length)
            result = HEAP + 16
        elif at == FREE:
            _, pointer, _, _ = args()
            assert pointer == HEAP + 16 and self.live_size is not None
            assert bytes(cpu.mem_read(HEAP, 16)) == b'\xa5' * 16
            assert bytes(cpu.mem_read(pointer + self.live_size, 16)) == b'\xa5' * 16
            self.live_size = None
            result = 0
        elif at == 0x5313fd80:
            dst, src, length, _ = args()
            assert dst == HEAP + 16 and length == self.live_size
            cpu.mem_write(dst, bytes(cpu.mem_read(src, length)))
            result = dst
        elif at == 0x5362e068:  # Filesystem create/preparation service.
            result = 1
        elif at == 0x5362e8d4:  # Lowest intercepted file-write request.
            resource, name, content, length = args()
            assert resource == RESOURCE and content == HEAP + 16 and length == self.live_size
            self.writes.append(dict(path=string(cpu, name), bytes=length,
                sha256=hashlib.sha256(bytes(cpu.mem_read(content, length))).hexdigest()))
            result = 1
        elif at == 0x536b9f1c:
            assert cpu.reg_read(reg.UC_ARM_REG_R0) != 0, 'Native resource write assertion'
            result = 1
        if result is None:
            return super()._hook(cpu, at, size, user)
        cpu.reg_write(reg.UC_ARM_REG_R0, result)
        cpu.reg_write(reg.UC_ARM_REG_PC, cpu.reg_read(reg.UC_ARM_REG_LR))

    def run(self, mode, records, count, fail_mount=None):
        assert len(records) < 0x800000
        self.writes, self.mounts, self.allocations = [], [], []
        self.fail_mount = fail_mount
        self.uc.mem_write(RECORDS, records)
        put(self.uc, OBJECT + 0x34, mode)
        result = self.call(RESOURCE_WRITER, OBJECT, count, RECORDS)
        assert self.live_size is None
        return dict(mode=mode, result=result, writes=list(self.writes),
            mounted=list(self.mounts), allocations=len(self.allocations))

    def run_section(self, mode, records, count):
        self.writes, self.mounts, self.allocations, self.section_headers = [], [], [], []
        self.fail_mount = None
        section = b'RES\0\0\0\0\0' + struct.pack('<HHI', 6, 65535, count) + records
        self.uc.mem_write(RECORDS, section)
        put(self.uc, OBJECT + 0x24, RECORDS)
        put(self.uc, OBJECT + 0x28, len(section))
        put(self.uc, OBJECT + 0x34, mode)
        result = self.call(0x5362a4c0, OBJECT)
        assert self.live_size is None
        # Native code treats RES as the last meaningful section. Verify that
        # the appended file doesn't accidentally resemble another section.
        assert len(self.section_headers) == 2
        assert self.section_headers[0][2:] == [0xffff0006, count]
        assert (self.section_headers[1][2] & 0xffff) not in range(1, 9)
        assert self.section_headers[1][3] > len(section)
        return dict(mode=mode, result=result, section_headers=self.section_headers,
                    writes=list(self.writes), native_RES_dispatch_and_tail_walk=True)


class ShutdownProbe(NativeProbe):
    def __init__(self, data, candidate):
        self.selected = []
        super().__init__(data)
        overlay(self, candidate)
        for at, val in ((SYS + 4, SYS + 0x100), (SYS + 0x10c, SYS + 0x200),
                        (SYS + 0x21c, SYS + 0x300)):
            put(self.uc, at, val)

    def _hook(self, cpu, at, size, user):
        result = None
        if at == 0x5320ad88:
            result = APP
        elif at == 0x5320b13c:
            result = GEOMETRY
        elif at == 0x5320b07c:
            result = DISPLAY
        elif at == 0x53525d5c:
            result = SYS
        elif at == 0x53233fb0:
            result = cpu.reg_read(reg.UC_ARM_REG_R0)
            cpu.mem_write(result, struct.pack('<2I', 720, 480))
        elif at == JPEG_REQUEST and self.selecting:
            self.selected.append(cpu.reg_read(reg.UC_ARM_REG_R1))
            result = 1
        if result is None:
            return super()._hook(cpu, at, size, user)
        cpu.reg_write(reg.UC_ARM_REG_R0, result)
        cpu.reg_write(reg.UC_ARM_REG_PC, cpu.reg_read(reg.UC_ARM_REG_LR))

    def selection(self, edition):
        self.selecting, self.selected = True, []
        put(self.uc, SYS + 0x348, edition)
        self.call(BACKGROUND, OBJECT)
        assert len(self.selected) == 1
        return self.selected[0]

    def jpeg_request(self, index):
        self.selecting = False
        cpu = self.uc
        cpu.reg_write(reg.UC_ARM_REG_CPSR, 0x13)
        cpu.reg_write(reg.UC_ARM_REG_SP, STACK)
        cpu.reg_write(reg.UC_ARM_REG_LR, STOP)
        cpu.mem_write(STACK - 0x1000, bytes(0x2000))
        cpu.mem_write(OUTPUT, struct.pack('<4I', 720, 480, 0, 0))
        for n, value in enumerate((DISPLAY, index, OUTPUT, OUTPUT + 8)):
            cpu.reg_write(getattr(reg, 'UC_ARM_REG_R' + str(n)), value)
        # Stop after the native path and size setters, before display-queue I/O.
        cpu.emu_start(JPEG_REQUEST, 0x5322e5c0, count=10000, timeout=2_000_000)
        assert cpu.reg_read(reg.UC_ARM_REG_PC) == 0x5322e5c0
        request = cpu.reg_read(reg.UC_ARM_REG_FP) - 0x64
        assert bytes(cpu.mem_read(request + 4, 1)) == b'\x05'
        return dict(id=index, path=string(cpu, u32(cpu, request + 12)),
                    dimensions=list(struct.unpack('<2I', cpu.mem_read(request + 16, 8))))


def verify(data, parent_rtos, candidate_rtos, records, expected_resources):
    n = ResourceProbe(data, candidate_rtos)
    rows = []
    for mode in range(5):
        row = n.run(mode, records, len(expected_resources))
        expected = [r for r in expected_resources if not (mode == 2 and r['path'].startswith('B:'))]
        assert row['result'] == 1 and row['writes'] == expected
        assert row['mounted'] == list('ABEFGHI')
        assert row['allocations'] == len(expected)
        rows.append(row)
    ordinary = rows[2]
    assert NEW_PATH in [r['path'] for r in ordinary['writes']]
    assert OLD_PATH not in [r['path'] for r in ordinary['writes']]
    assert next(r for r in ordinary['writes'] if r['path'] == NEW_PATH)['bytes'] == 49116
    assert n.run(2, records, len(expected_resources), fail_mount='A')['result'] == 0
    assert not n.writes and not n.allocations
    section = n.run_section(2, records, len(expected_resources))
    assert section['result'] == 1 and section['writes'] == ordinary['writes']

    old, new = ShutdownProbe(data, parent_rtos), ShutdownProbe(data, candidate_rtos)
    editions = []
    for edition, jpeg_id in enumerate((2, 3, 11, 10, 12)):
        assert old.selection(edition) == new.selection(edition) == jpeg_id
        editions.append(dict(edition=edition, jpeg_id=jpeg_id))
    descriptors = []
    for index in range(13):
        before, after = old.jpeg_request(index), new.jpeg_request(index)
        if index == 2:
            assert before['path'] == OLD_PATH and after['path'] == NEW_PATH
            assert before['dimensions'] == after['dimensions'] == [720, 480]
        else:
            assert before == after
        descriptors.append(after)
    return dict(passed=True, cases=7 + 10 + 26, resource_update_modes=rows,
        native_RES_dispatch=section,
        mode2_skips_factory_B_drive=True, mode2_writes_new_A_image=True,
        mount_failure_aborts_before_write=True, native_resource_permission_and_create=True,
        shutdown_editions=editions, jpeg_requests=descriptors,
        native_path_and_dimensions_setters=True, all_other_jpeg_descriptors_preserved=True,
        physical_io_performed=False, hardware_tested=False,
        scope=__doc__.strip())
