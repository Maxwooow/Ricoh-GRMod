"""Run IIIx's original independent RGB-curve composition and ISP-table encoder.

Only synthetic RAM inputs and the original T4 patch set are used. These tests
establish a possible CUBE port entry point, not firmware support or color accuracy.
"""
import argparse
import hashlib
import json
import math
import struct
from pathlib import Path
from image_control_probe import LookProbe, GAMMA_BUFFERS, GAMMA_OBJECT
from native_probe import RTOS_SHA

ISP = 0x620a0000
COMPOSE = 0x536e8be0
INPUTS = (0x2a08, 0x2c08, 0x2e08, 0x3008)
OUTPUTS = (0x204, 0x404, 0x604, 0x804)
LINEAR = [i * 64 for i in range(256)]


def interpolate(curve, sample):
    index, fraction = sample >> 6, sample & 63
    if index >= 255:
        return curve[255]
    delta = (curve[index + 1] - curve[index]) * fraction
    # The native signed division truncates towards zero.
    return curve[index] + math.trunc(delta / 64)


def verify(data, manifest):
    probe = LookProbe(data, manifest)
    cpu = probe.uc
    calls = 0
    cpu.mem_write(ISP - 32, b'\xa5' * (0x3400 + 64))
    cpu.mem_write(ISP, bytes(0x3400))
    cases = []
    profiles = [
        ('identity', [LINEAR, LINEAR, LINEAR]),
        ('separate-channels', [LINEAR, [i * 32 for i in range(256)], [min(16383, i * 80) for i in range(256)]]),
        ('shadows-and-highlights', [[round((i / 255) ** exponent * 16383) for i in range(256)] for exponent in (.8, 1.2, 1.7)]),
    ]
    # Input ramps include fractional LUT indices and the last-interval clamp.
    ramps = [LINEAR, [min(16383, i * 64 + (i % 64)) for i in range(256)]]
    for ramp_index, ramp in enumerate(ramps):
        for off in INPUTS:
            cpu.mem_write(ISP + off, struct.pack('<256H', *ramp))
        for index, (name, curves) in enumerate(profiles):
            identity = 0x10000 + ramp_index * 16 + index
            for pointer, curve in zip(GAMMA_BUFFERS, curves):
                cpu.mem_write(pointer, struct.pack('<256H', *curve))
            cpu.mem_write(GAMMA_OBJECT + 12, b'\1\1')
            cpu.mem_write(GAMMA_OBJECT + 20, struct.pack('<I', identity))
            probe.call(COMPOSE, ISP, 0)
            calls += 1
            composed = [[interpolate(curve, v) for v in ramp] for curve in curves]
            luminance = [(77 * r + 150 * g + 29 * b) >> 8 for r, g, b in zip(*composed)]
            for off, expected in zip(OUTPUTS, composed + [luminance]):
                actual = struct.unpack('<256H', cpu.mem_read(ISP + off, 512))
                assert actual == tuple(min(1023, v >> 4) for v in expected), (name, ramp_index, off)
            assert struct.unpack('<I', cpu.mem_read(ISP + 0x3234, 4))[0] == identity
            encoded = bytes(cpu.mem_read(ISP + 0x204, 0x2800))
            # Same key and unchanged inputs must leave the native cached output intact.
            probe.call(COMPOSE, ISP, 0)
            calls += 1
            assert cpu.mem_read(ISP + 0x204, 0x2800) == encoded
            cases.append({'profile': name, 'fractional_input': bool(ramp_index),
                          'curve_identity': identity, 'encoded_sha256': hashlib.sha256(encoded).hexdigest()})
        # Leaving an imported profile must remove its per-channel transformation.
        cpu.mem_write(GAMMA_OBJECT + 12, b'\0\0')
        probe.call(COMPOSE, ISP, 0)
        calls += 1
        for off in OUTPUTS:
            assert struct.unpack('<256H', cpu.mem_read(ISP + off, 512)) == tuple(min(1023, v >> 4) for v in ramp)
    assert cpu.mem_read(ISP - 32, 32) == b'\xa5' * 32
    assert cpu.mem_read(ISP + 0x3400, 32) == b'\xa5' * 32
    return {
        'schema': 1, 'rtos_sha256': hashlib.sha256(data).hexdigest(), 'native_calls': calls, 'cases': cases,
        'three_independent_256_entry_14_bit_input_curves': True,
        'original_curve_interpolation_and_10_bit_isp_encoding': True,
        'native_luminance_combination': True, 'fractional_input_and_highlight_clamp': True,
        'profile_key_switch_and_cache_reuse': True, 'leaving_profile_restores_base_curves': True,
        'buffer_canaries': True, 'color_calibration_verified': False,
        'firmware_generated': False, 'hardware_tested': False,
        'remaining': 'Connect a validated IIIx matrix/curve fit to per-image look selection, metadata and persistence. GR IV calibration was not used.',
    }


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for arg in ('rtos', 'base', 'report'):
        p.add_argument('--' + arg, type=Path, required=True)
    args = p.parse_args()
    report = verify(args.rtos.read_bytes(), json.loads(args.base.read_text()))
    with args.report.open('x') as stream:
        json.dump(report, stream, indent=2)
        stream.write('\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'cases'}, indent=2))
