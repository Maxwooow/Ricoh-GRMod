# SPDX-License-Identifier: GPL-2.0-only
"""Where a build put the movie AF (core/src/fw/gr4v120/aspect/videoaf.ts): read from the RTOS image itself.

layout(image) -> {'ctx', 'code', 'wobbleStub', 'stopStub', 'voteStub', 'monitorStub', 'speedStub', 'lensStub', 'askStub',
                  'noFiles', 'flags', 'fast', 'perUnit', 'fastest'}
with_files(image, L) -> the image with the camera's file service in the context (word 7) in place of the build's stub, so
that the tests can read the record the module writes when a recording ends; the build itself writes nothing."""
import struct

BASE = 0x53000000
MAGIC = 0x51414656                                    # "VFAQ"
FILE_SERVICE = 0x537d0668                             # the camera's file service holder (the flash module's native)
WOBBLE_CALL, STOP_SLOT, VOTE_CALL, MONITOR_CALL, SPEED_WORD, LENS_TEST, ASK_CALL = 0x53626a44, 0x53ee06f8, 0x5363003c, 0x53627020, 0x53630e20, 0x539530fc, 0x53615130


def layout(image):
    word = lambda a: struct.unpack_from('<I', image, a - BASE)[0]
    target = lambda a: a + 8 + ((word(a) & 0xffffff ^ 0x800000) - 0x800000) * 4
    imm16 = lambda w: ((w >> 4) & 0xf000) | (w & 0xfff)
    L = dict(wobbleStub=target(WOBBLE_CALL), stopStub=word(STOP_SLOT), voteStub=target(VOTE_CALL), monitorStub=target(MONITOR_CALL),
             speedStub=target(SPEED_WORD), lensStub=target(LENS_TEST), askStub=target(ASK_CALL))
    assert all(v - BASE >= 0x400000 for v in L.values()), 'this image does not have the movie AF'
    s = L['wobbleStub']                               # push {r4,lr}; mov r2,r0; movw r0,#ctx; movt r0,#ctx; mov r1,#0; mov r3,#0; bl code
    assert word(s + 8) & 0xfff0f000 == 0xe3000000 and word(s + 12) & 0xfff0f000 == 0xe3400000, 'wobbling stub: no movw / movt r0'
    L['ctx'] = imm16(word(s + 8)) | imm16(word(s + 12)) << 16
    L['code'] = target(s + 24)
    assert word(L['ctx']) == MAGIC, 'context magic'
    L['flags'] = word(L['ctx'] + 8); L['noFiles'] = word(L['ctx'] + 28)
    sp = L['speedStub']                               # ... mov r7,#perUnit (+40); mul; movw ip,#fastest (+48)
    L['fast'] = 1; L['perUnit'] = word(sp + 40) & 0xff; L['fastest'] = imm16(word(sp + 48))
    return L


def with_files(image, L):
    out = bytearray(image)
    struct.pack_into('<I', out, L['ctx'] + 28 - BASE, FILE_SERVICE)
    return bytes(out)
