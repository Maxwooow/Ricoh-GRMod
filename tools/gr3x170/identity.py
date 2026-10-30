"""Identities of the official images the IIIx port is applied to: GR IIIx 1.70 / GR III 2.20
(generated port of tools/gr3x, see tools/port/gr3-p2.json).

GR IIIx 1.70 and GR III 2.20 are the same build of one program (as 1.60 / 2.10): every function and data address
is identical; they differ only in identity bytes (camera name, project/product number, version,
build time, RTC epoch year). Probes accept either exact RTOS and look up the identity here.
"""
import hashlib

PROFILES = [
    dict(id='gr3x-hdf-1.70', camera='GR IIIx', tag='GR3X-HDF-170', filename='fwdc243b.bin',
         project=609, product=78490, version_word=0x01461412,
         container_sha256='aa8e3ae1349d94e83be381c20530e41d5e57b75c27ef24ba81c7b017d6c11592',
         decoded_sha256='1129b9289b3cc68ab6f407a87d60db750483cc5ae41a6609596f6fe676b14521',
         rtos_sha256='3d97f0f541c6711b56dcd66ffc081be97af303708cc1874b29f9bd8ee7a8d0c5'),
    dict(id='gr3-hdf-2.20', camera='GR III', tag='GR3-HDF-220', filename='fwdc239b.bin',
         project=588, product=78350, version_word=0x0214141c,
         container_sha256='5c53760b3b564c87239dbf7f5c94d0f6fd91accd156ec4ba672ebfd6b861793e',
         decoded_sha256='5b475fcc434dec0f12e7956b02b5b38959d599b7a4ff90486263c46816a21b6d',
         rtos_sha256='fb13f9b4e49abec5f036d3f9fc5e4d21ba2a4e65522efb849ac52a7151c87da9'),

]
RTOS_SHAS = {p['rtos_sha256'] for p in PROFILES}

def by_rtos(data):
    sha = hashlib.sha256(data).hexdigest()
    for p in PROFILES:
        if p['rtos_sha256'] == sha: return p
    raise ValueError('Unknown GR III / IIIx RTOS; refusing fixed addresses')

def by_container(raw):
    sha = hashlib.sha256(raw).hexdigest()
    for p in PROFILES:
        if p['container_sha256'] == sha: return p
    raise ValueError('Unknown GR III / IIIx official container')

def by_id(pid):
    for p in PROFILES:
        if p['id'] == pid: return p
    raise ValueError('Unknown profile id ' + str(pid))
