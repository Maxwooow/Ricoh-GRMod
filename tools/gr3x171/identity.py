"""Identities of the official images the IIIx port is applied to: GR IIIx 1.71 / GR III 2.21
(generated port of tools/gr3x170, see tools/port/gr3-p3.json).

GR IIIx 1.70 and GR III 2.20 are the same build of one program (as 1.60 / 2.10): every function and data address
is identical; they differ only in identity bytes (camera name, project/product number, version,
build time, RTC epoch year). Probes accept either exact RTOS and look up the identity here.
"""
import hashlib

PROFILES = [
    dict(id='gr3x-hdf-1.71', camera='GR IIIx', tag='GR3X-HDF-171', filename='fwdc243b.bin',
         project=609, product=78490, version_word=0x01471413,
         container_sha256='7d7e9d8173bcc8bcc8bab1df185ae66671ff2a33c870067a6f4c029c628bedc9',
         decoded_sha256='3d91125318fb3c1dd19012292dd99b5053139302b05f1d9d1bfe22d620e046ac',
         rtos_sha256='2ba5e74c6b1564c5787c068d46bdf90b7571b497d2d543309e7a930b98e5b75c'),
    dict(id='gr3-hdf-2.21', camera='GR III', tag='GR3-HDF-221', filename='fwdc239b.bin',
         project=588, product=78350, version_word=0x0215141d,
         container_sha256='7522c36b74294fa854391217f151ef731a4ebbd6ef4449dcf05684828aea4bd9',
         decoded_sha256='aed094bf84870155bbc25e3151e042f50f37e6c1deec26532c98f39570c2ee5f',
         rtos_sha256='9117ae44764d6c542c2b8d1b138a6132261125873c7d77f571277767279463b7'),

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
