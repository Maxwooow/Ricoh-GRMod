"""Round 9: the live view sees each film as a look of its own (core/src/fw/gr3x/image-control.ts).

The live view's change detection (0x536dc860, called for every frame by 0x536de0f4) compares the
frame's look with the one it saw last ([obj+0x1a8]) and, when it differs, marks modules to be
computed again (0x536de0f4 then calls them): the colour matrix (obj+5; a film's second matrix is
copied there too), the multi-axis colour (obj+6) and the YCbCr matrix (obj+7), but not the gamma
(obj+0xe), which holds a film's curves; round 9 also marks the gamma on a change of look. Up to round 8 the look it read was a film's native base (Standard), so from one film to
another (or from Standard to a film) nothing was marked: the live view, and pictures taken
without a full set-up, kept the previous film's colour until a parameter changed.

Here the camera's own function runs (the development step and the film adapters as built; the
frame's settings as image_control_probe.py's descriptor sets them up), for a sequence of looks,
the flags cleared before each frame:

  - round 9: the matrix and gamma flags (obj+5, obj+0xe) are set on every frame whose look
    differs from the one before, films included, and only then (the same look twice: not set);
    the remembered look is the look itself; in both live modes (1 and 2);
  - round 8 (and earlier film builds): the same check documents the fault: from one film to
    another the flag stays clear (reported, not asserted);
  - registers and stack as the camera's code leaves them, the function returns.
"""
import argparse, hashlib, json
from pathlib import Path
from unicorn import arm_const as reg
from image_control_probe import LookProbe, CONTEXT, COMMON
from native_probe import OBJECT

if not __debug__: raise RuntimeError('Validation requires Python assertions')
LIVE, LAST = 0x536dc860, 0x1a8
# The live view's frames: the context's mode byte (+0x82ac) 1, the frame's record then at its
# pointer (+0x82d0) + 0x71248 (0x536dc884); modes 1 and 2 compare with the last frame, the others
# set everything up every time.
MODE, RECORD = 0x82ac, 0x71248
FLAGS = range(4, 0x13)


def frames(probe, looks, mode=1):
    """Each look in turn as the frame's look; the matrix / second matrix / curve flags it leaves."""
    probe.descriptor(11)
    probe.uc.mem_write(OBJECT + LAST, b'\xff')          # as at start-up (0x536daf64)
    probe.uc.mem_write(CONTEXT + MODE, bytes([mode]))
    probe.uc.mem_write(COMMON + RECORD, bytes(0x2000))
    probe.uc.mem_write(COMMON + RECORD + 0x77d, bytes([4]) * 6)
    out = []
    for look in looks:
        probe.uc.mem_write(COMMON + RECORD + 0x77c, bytes([look]))
        for f in FLAGS: probe.uc.mem_write(OBJECT + f, b'\0')
        probe.call(LIVE, OBJECT, CONTEXT)
        flags = bytes(probe.uc.mem_read(OBJECT + 4, 0xf))
        out.append((look, flags[1], flags[2], flags[0xa], probe.uc.mem_read(OBJECT + LAST, 1)[0]))
    return out


def verify(data, manifest):
    assert manifest['kind'] == 'gr3x-image-control-patchset' and manifest.get('filmCount')
    films = manifest['filmCount']
    sequence = [21, 64, 65, 64, 64, 11, 64 + films - 1, 11, 11, 12, 12, 64]
    result = dict(schema=1, rtos_sha256=hashlib.sha256(data).hexdigest(), round9=bool(manifest.get('round9')), hardware_tested=False,
                  scope='0x536dc860 natively (with the development step and the film adapters as built); the modules it marks are not executed here.')
    for mode in (1, 2):
        p = LookProbe(data, manifest)
        seen = frames(p, sequence, mode)
        prev = None
        film_to_film = []
        for look, matrix, multi, gamma, last in seen:
            differs = prev is None or look != prev
            if manifest.get('round9'):
                assert matrix == (1 if differs else 0) and gamma == matrix, (mode, prev, look, matrix, gamma)
                assert last == look, (look, last)
            if prev is not None and prev >= 64 and look >= 64 and look != prev: film_to_film.append(bool(matrix and gamma))
            prev = look
        result[f'mode{mode}'] = dict(frames=seen, film_to_film_refreshed=film_to_film)
        if manifest.get('round9'): assert film_to_film and all(film_to_film)
    result['calls'] = 2 * (len(sequence) + 1)
    return result


if __name__ == '__main__':
    a = argparse.ArgumentParser(description=__doc__)
    for s in ('rtos', 'manifest', 'report'): a.add_argument('--' + s, type=Path, required=True)
    a = a.parse_args(); result = verify(a.rtos.read_bytes(), json.loads(a.manifest.read_text()))
    with a.report.open('x') as f: json.dump(result, f, indent=2); f.write('\n')
    print(json.dumps(result, indent=2))
