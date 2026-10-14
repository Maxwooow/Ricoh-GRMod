"""Independently decode W2 and execute the newly covered native update/display paths."""
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
from shutdown_update_probe import verify as shutdown_update, NEW_PATH, BASE
from factory_probe import model_probe
from wallpaper_package_probe import resources

if not __debug__:
    raise RuntimeError('Run without Python -O')
sha = lambda data: hashlib.sha256(data).hexdigest()
PARENT_SHA = 'ad8ad418004d5eed20644e396f1361d081033fb050c172047b7614bc92934a91'
IMAGE_SHA = 'd30f49e8fd7c8ab7b368efcf37383d1e29812246e8db5e6127c12da4908285f5'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('official', 'parent', 'candidate', 'report', 'jpeg', 'reference', 'output'):
        p.add_argument('--' + name, type=Path, required=True)
    a = p.parse_args()
    a.output.mkdir()
    sys.path.insert(0, str(a.reference.resolve()))
    from gr4_editor.codec.container import inspect_container, sum32
    from gr4_editor.codec.frames import decode_payload, section_rows
    official, parent = a.official.read_bytes(), (a.parent / 'fwdc243b.bin').read_bytes()
    candidate, jpeg = a.candidate.read_bytes(), a.jpeg.read_bytes()
    assert sha(parent) == PARENT_SHA and sha(jpeg) == IMAGE_SHA and len(jpeg) == 49116
    manifest = json.loads((a.parent / 'patch-manifest.json').read_text())
    parent_report = json.loads((a.parent / 'build-report.json').read_text())
    report = json.loads(a.report.read_text())
    assert report['outputSha256'] == sha(candidate) and report['parentSha256'] == PARENT_SHA
    assert report['deliveryRevision'] == 'T6-J1-W2' and report['revision'] == 'T6-J1'
    parent_check = parent_package(official, parent, manifest, parent_report, a.reference)
    print('Parent T6-J1: pinned independent codec validation passed', flush=True)
    parent_info, info = inspect_container(parent), inspect_container(candidate)
    for key in ('project', 'header_project_copy', 'header_marker', 'footer_project_copy',
                'footer_marker', 'firmware_type', 'metadata_length', 'header_record_count'):
        assert info[key] == parent_info[key]
    assert candidate[:128] == parent[:128] and info['additive_sum32'] == 0
    assert info['project'] == 609 and info['metadata_length'] == 0
    before, old_frames = decode_payload(parent[128:parent_info['payload_end']], parent_info['decoded_size'])
    after, frames = decode_payload(candidate[128:info['payload_end']], info['decoded_size'])
    assert len(after) == len(before) + 0xc000 and sum32(after) == 0
    assert sha(after) == report['decodedSha256']
    old_sections, sections = section_rows(before), section_rows(after)
    assert sections[:-1] == old_sections[:-1]
    assert sections[-1] == dict(old_sections[-1], end=old_sections[-1]['end'] + 0xc000, resource_count=36)
    old_res, new_res = resources(before, old_sections), resources(after, sections)
    insertion_at = old_sections[-1]['start'] + 16
    assert insertion_at == 53712936
    assert new_res[0] == (NEW_PATH, insertion_at + 36, 49116)
    assert after[insertion_at + 36:insertion_at + 0xc000] == jpeg
    assert new_res[1:] == [(name, offset + 0xc000, size) for name, offset, size in old_res]
    for (name, offset, size), (_, new_offset, _) in zip(old_res, new_res[1:]):
        assert after[new_offset - 36:new_offset + size] == before[offset - 36:offset + size]
    rt = sections[5]
    assert rt['name'] == 'RTOS' and rt['start'] + 16 == 67696 and rt['end'] == 18030128
    rt_start, checksum_offset = rt['start'] + 16, rt['end'] - 4
    pointer, extension = rt_start + 0xb5f544, rt_start + 0x1121500
    assert before[extension:extension + 128] == bytes(128)
    extension_marker = b'GR3X-SHUTDOWN-W2\0'
    assert after[extension:extension + len(extension_marker)] == extension_marker
    expected_extension = bytearray(128)
    expected_extension[:len(extension_marker)] = extension_marker
    encoded_path = NEW_PATH.encode() + b'\0'
    expected_extension[32:32 + len(encoded_path)] = encoded_path
    assert after[extension:extension + 128] == expected_extension
    assert struct.unpack_from('<I', before, pointer)[0] == 0x53b22abc
    assert struct.unpack_from('<I', after, pointer)[0] == BASE + extension + 32 - rt_start
    planned = [(pointer, pointer + 4), (extension, extension + 128),
               (checksum_offset, checksum_offset + 4), (insertion_at - 4, insertion_at)]
    assert [(r['offset'], r['offset'] + r['length']) for r in report['parentPreservation']['ranges']] == planned
    restored = bytearray(after[:insertion_at] + after[insertion_at + 0xc000:])
    for start, end in planned:
        restored[start:end] = before[start:end]
    assert restored == before, 'Candidate has undeclared changes to T6-J1'
    assert after[-4:] == before[-4:]
    assert len(frames) == len(old_frames) + 2
    for f, old_f in ((frames[0], old_frames[0]), (frames[-1], old_frames[-1])):
        assert candidate[128 + f.encoded_start:128 + f.encoded_end] == parent[128 + old_f.encoded_start:128 + old_f.encoded_end]
    assert all(f.decoded_end - f.decoded_start == 0x6000 for f in frames[1:-1])
    assert all(not f.literal or f.decoded_end - f.decoded_start == 0x6000 for f in frames)
    with Image.open(io.BytesIO(jpeg)) as im:
        assert im.format == 'JPEG' and im.size == (720, 480) and im.mode == 'RGB'
        assert not im.info.get('progressive') and JpegImagePlugin.get_sampling(im) == 2
        im.load()
        im.save(a.output / '关机图-从固件解码.png')
    print('W2: new resource, exact parent preservation, checksum and image checks passed', flush=True)

    data = (a.parent / 'validation-inputs/rtos.bin').read_bytes()
    boot = (a.parent / 'validation-inputs/boot.bin').read_bytes()
    loader_check = loader(data, boot, official, candidate, report)
    jpeg_check = jpeg_metadata(data, manifest, a.output / 'jpeg-fixtures')
    models = model_probe(data)
    resource_rows = [dict(path=name, bytes=size, sha256=sha(after[offset:offset + size]))
                     for name, offset, size in new_res]
    shutdown_check = shutdown_update(data, before[rt_start:rt['end']], after[rt_start:rt['end']],
                                    after[insertion_at:-4], resource_rows)
    results = {'parent-independent-codec':parent_check, 'updater-loader':loader_check,
               'jpeg-metadata':jpeg_check, 'camera-model':{'models':models},
               'resource-update-and-shutdown':shutdown_check}
    for name, result in results.items():
        (a.output / (name + '.json')).write_text(json.dumps(result, indent=2) + '\n')
    summary = dict(schema=1, kind='gr3x-T6-J1-W2-validation', all_checks_passed=True,
        candidate_sha256=sha(candidate), parent_sha256=PARENT_SHA,
        planned_ranges=planned, resource_count=36, unchanged_original_resources=35,
        unchanged_runtime_code=True, jpg_film_identity_unchanged=True,
        native_function_cases=loader_check['calls'] + jpeg_check['cases'] + len(models) + shutdown_check['cases'],
        jpeg_metadata_cases=jpeg_check['cases'], shutdown_update_cases=shutdown_check['cases'],
        shutdown_image_sha256=IMAGE_SHA, new_A_resource_written_in_mode2=True,
        native_generic_shutdown_reads_new_path=True, hardware_tested=False, camera_io_performed=False,
        limitations=['Filesystem services are fixtures; physical flash, hardware JPEG decode and screen display need camera testing.'])
    (a.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == '__main__':
    main()
