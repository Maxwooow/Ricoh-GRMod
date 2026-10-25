"""Identities of the official images the IIIx port is applied to.

GR IIIx 1.60 and GR III 2.10 are the same build of one program: every function and data address
is identical; they differ only in identity bytes (camera name, project/product number, version,
build time, RTC epoch year). Probes accept either exact RTOS and look up the identity here.
"""
import hashlib

PROFILES = [
    dict(id='gr3x-hdf-1.60', camera='GR IIIx', tag='GR3X-HDF-160', filename='fwdc243b.bin',
         project=609, product=78490, version_word=0x013c0b11,
         container_sha256='708e79f3b7b96a7e1581b4acf4c412233050a1832718ef7f06c8397db1b431c7',
         decoded_sha256='c4bfc09d1148deec2155b21bd3d63be8085cf835cbe5e5cde4832747f519e630',
         rtos_sha256='0f11b0d28bc67932d044c5d01bc0314844a756057c89984278c73a23449a24c6'),
    dict(id='gr3-hdf-2.10', camera='GR III', tag='GR3-HDF-210', filename='fwdc239b.bin',
         project=588, product=78350, version_word=0x020a151b,
         container_sha256='d6a3c9c288d784080e7b283222ecdd8752adfeed6faa36dab44f73115354bfd4',
         decoded_sha256='53da690797f35ad6dc2c429d8ca1d0de8e333c211ed959816813982cd093b703',
         rtos_sha256='8a4eafcad2716e0b21e9909264e1242e534f0e39e05cba82a53546ceb4070b67'),
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
