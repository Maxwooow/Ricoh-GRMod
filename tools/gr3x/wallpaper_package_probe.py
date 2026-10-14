"""Independently verify the exact T6-J1 anniversary resource replacement.

Uses the pinned Python codec, libjpeg and original ARM probes. It does not
emulate camera flash writes, the hardware JPEG decoder or physical shutdown.
"""
import argparse
import hashlib
import io
import json
import struct
import sys
from pathlib import Path
from PIL import Image, JpegImagePlugin
from package_probe import verify as parent_package
from loader_probe import verify as loader
from jpeg_metadata_probe import verify as jpeg_metadata
from factory_probe import model_probe

if not __debug__:
    raise RuntimeError('Run without Python -O')

sha = lambda data: hashlib.sha256(data).hexdigest()
PARENT_SHA = 'ad8ad418004d5eed20644e396f1361d081033fb050c172047b7614bc92934a91'
IMAGE_SHA = '60704ffd3c4775c33e78f9404b3676db4edf3f78aec59773e3407b4f1fc54c17'
RESOURCE_PATH = 'B:\\Resource\\Jpeg\\GoodBye.jpg'


def resources(data, sections):
    section = next(s for s in sections if s['name'] == 'RES')
    count = struct.unpack_from('<I', data, section['start'] + 12)[0]
    offset, rows = section['start'] + 16, []
    for _ in range(count):
        assert offset + 36 <= len(data)
        name = data[offset:offset + 32].split(b'\0')[0].decode('ascii')
        length = struct.unpack_from('<I', data, offset + 32)[0]
        assert name and offset + 36 + length <= len(data)
        assert name not in [r[0] for r in rows]
        rows.append((name, offset + 36, length))
        offset += 36 + length
    assert offset + 4 == len(data)  # Original payload trailer remains untouched.
    return rows


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('official', 'parent', 'candidate', 'report', 'jpeg', 'reference', 'output'):
        p.add_argument('--' + name, type=Path, required=True)
    a = p.parse_args()
    a.output.mkdir()
    sys.path.insert(0, str(a.reference.resolve()))
    from gr4_editor.codec.container import inspect_container, sum32
    from gr4_editor.codec.frames import decode_payload, section_rows

    official, parent, candidate = a.official.read_bytes(), (a.parent / 'fwdc243b.bin').read_bytes(), a.candidate.read_bytes()
    assert sha(parent) == PARENT_SHA
    manifest = json.loads((a.parent / 'patch-manifest.json').read_text())
    parent_report = json.loads((a.parent / 'build-report.json').read_text())
    report = json.loads(a.report.read_text())
    assert report['outputSha256'] == sha(candidate) and report['parentSha256'] == PARENT_SHA
    assert report['deliveryRevision'] == 'T6-J1-W1' and report['revision'] == 'T6-J1'
    parent_check = parent_package(official, parent, manifest, parent_report, a.reference)
    print('Parent T6-J1: pinned independent codec validation passed', flush=True)
    parent_info, info = inspect_container(parent), inspect_container(candidate)
    for key in ('project', 'header_project_copy', 'header_marker', 'footer_project_copy',
                'footer_marker', 'firmware_type', 'decoded_size', 'metadata_length', 'header_record_count'):
        assert info[key] == parent_info[key]
    assert candidate[:128] == parent[:128] and info['additive_sum32'] == 0
    assert info['project'] == 609 and info['metadata_length'] == 0
    before, old_frames = decode_payload(parent[128:parent_info['payload_end']], parent_info['decoded_size'])
    after, frames = decode_payload(candidate[128:info['payload_end']], info['decoded_size'])
    assert len(before) == len(after) and sum32(after) == 0
    assert sha(after) == report['decodedSha256']
    old_sections, sections = section_rows(before), section_rows(after)
    assert sections == old_sections
    old_res, new_res = resources(before, old_sections), resources(after, sections)
    assert new_res == old_res
    path, offset, size = next(r for r in new_res if r[0] == RESOURCE_PATH)
    jpeg = a.jpeg.read_bytes()
    assert len(jpeg) == size == 7264 and sha(jpeg) == IMAGE_SHA
    assert after[offset:offset + size] == jpeg
    rtos = next(s for s in sections if s['name'] == 'RTOS')
    checksum_offset = rtos['end'] - 4
    planned = [(offset, offset + size), (checksum_offset, checksum_offset + 4)]
    assert report['parentPreservation']['ranges'] == [
        dict(what='IIIx HDF GoodBye.jpg: user-supplied GR DIGITAL 20th anniversary', offset=offset, length=size),
        dict(what='Existing T6-J1 payload checksum compensation', offset=checksum_offset, length=4),
    ]
    restored = bytearray(after)
    for start, end in planned:
        restored[start:end] = before[start:end]
    assert restored == before
    assert after[rtos['start']:checksum_offset] == before[rtos['start']:checksum_offset]
    unchanged_resources = 0
    for name, start, length in new_res:
        if name != RESOURCE_PATH:
            assert after[start - 36:start + length] == before[start - 36:start + length]
            unchanged_resources += 1
    assert unchanged_resources == len(new_res) - 1
    assert before[-4:] == after[-4:]
    assert len(frames) == len(old_frames)
    assert [(f.decoded_start, f.decoded_end) for f in frames] == [(f.decoded_start, f.decoded_end) for f in old_frames]
    with Image.open(io.BytesIO(jpeg)) as im:
        assert im.format == 'JPEG' and im.size == (720, 480) and im.mode == 'RGB'
        assert not im.info.get('progressive') and JpegImagePlugin.get_sampling(im) == 2
        im.load()
        im.save(a.output / '关机图-从固件解码.png')
    print('Candidate: exact resource replacement, checksum, JPEG and preservation checks passed', flush=True)

    data = (a.parent / 'validation-inputs/rtos.bin').read_bytes()
    boot = (a.parent / 'validation-inputs/boot.bin').read_bytes()
    loader_check = loader(data, boot, official, candidate, report)
    jpeg_check = jpeg_metadata(data, manifest, a.output / 'jpeg-fixtures')
    models = model_probe(data)
    assert any(r['selected_model'] == 'GR IIIx HDF' for r in models)
    results = {'parent-independent-codec':parent_check, 'updater-loader':loader_check,
               'jpeg-metadata':jpeg_check, 'camera-model':{'models':models}}
    for name, result in results.items():
        (a.output / (name + '.json')).write_text(json.dumps(result, indent=2) + '\n')
    summary = dict(schema=1, kind='gr3x-T6-J1-W1-validation', all_checks_passed=True,
        candidate_sha256=sha(candidate), parent_sha256=PARENT_SHA,
        planned_ranges=planned, resource_count=len(new_res), unchanged_resources=unchanged_resources,
        runtime_code_and_data_unchanged=True, jpg_film_identity_unchanged=True,
        native_function_cases=loader_check['calls'] + jpeg_check['cases'] + len(models),
        jpeg_metadata_cases=jpeg_check['cases'], shutdown_image_sha256=IMAGE_SHA,
        hardware_tested=False, camera_io_performed=False,
        limitations=['Physical firmware update, hardware JPEG decoding and shutdown display require camera testing.'])
    (a.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == '__main__':
    main()
