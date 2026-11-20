# SPDX-License-Identifier: GPL-2.0-only
"""Read the movie AF module's files (C:\\VQxxxxxx.BIN, written by vafquick.c when a recording stops).

usage: read_quick.py FILE_OR_DIR... [--csv OUT_DIR] [--rows]"""
import argparse, csv, struct, sys
from pathlib import Path

MAGIC = 0x51414656
HEADER = {4: '<8I 2I 6H 7I 4B', 5: '<8I 2I 6H 7I 4B 2H', 6: '<8I 2I 6H 7I 4B 2H', 7: '<8I 2I 6H 7I 4B 2H 2I', 8: '<8I 2I 6H 7I 4B 2H 2I 4I', 9: '<8I 2I 6H 7I 4B 2H 2I 4I', 10: '<8I 2I 6H 7I 4B 2H 2I 4I', 11: '<8I 2I 6H 7I 4B 2H 2I 4I'}
PROBES, PROBE_FRAMES = 12, 16
ZFRAME = ' h H 2B h 2B 5h 5H 5B B'        # 23 values: moved, median, flags, age, d14, dirs, quality, mid x 5, val x 5, rel x 5, pad
HEADER[12] = HEADER[11] + ' I' + (' I 2H 4B' + ZFRAME * (PROBE_FRAMES + 1)) * PROBES
HEADER[13] = HEADER[12]
RECORD = '<I I i i i 2h 4H 5H 2H H 2H h 5B 4B 4B 3B 4B 4B 2B'
FIELDS = (['t_us', 'frame', 'lens', 'lens_real', 'count', 'own_count', 'count_before', 'base', 'step', 'cap', 'wanted'] + [f'val{i}' for i in range(5)]
          + ['median', 'median_used', 'steps_in_climb', 'lens_speed', 'last_amount', 'moved'] + [f'rel{i}' for i in range(5)]
          + ['phase_of_step', 'verdict', 'direction', 'result', 'total_direction', 'total_valid', 'running', 'reliable', 'stock_verdict', 'forced', 'run',
             'motor', 'quiet', 'ready', 'returning', 'settle', 'distrust', 'campaign', 'reverse_block', 'age', 'marks'])
STANDBY = 0xee      # phase_of_step of a standby record; there: count = frames of this standby, verdict / direction / result = object + 0x85CA,
                    # the monitor's "scene changed" flag, object + 0x85CB; motor / quiet / ready / returning = object + 0x10CA6, + 0x10BA8, + 0x85CC, + 0x85E5
# Version 6: run = strong results in a row (5: agreeing results of 180 and more), median_used = what that row says is left (5: the median less the
# lens's movement in 18 frames), moved = the lens's movement since 8 frames before the result standing appeared (5: in 18 frames), steps_in_climb before
# the step (5: after), settle = frames until results count again, 255 while a fast step is under way (5: frames left of 18), age = frames the result
# standing has stood (5: module + 0xE7); marks: 1 fast step sent, 2 trust check started, 4 trust lost, 8 this step named for the fast speed,
# 16 fast step put off (first step of a climb), 32 new search asked for, 64 asked and refused.
# Version 7, standby records: step = lens units sent straight from standby (marks 128), wanted = the share of the value a step takes x 256, cap = searches of
# the camera refused since the last record (marks 16), own_count = follow row, count_before = areas reading "in focus", moved = lens units x 256 a value unit
# was worth in the last step, median_used = the value the step was sized by, settle as in focusing records; marks 4 = trust lost.
# Version 8, standby records: lens = who holds the lens (lens + 0x14; 2 = the movie AF) + 256 x "taken by the module for a step" + 512 x "no step straight
# in this recording any more" + 1024 x "nothing refused any more" + 2048 x "no step straight for a while"; marks 1 = the step sent was not taken by
# the lens (its position unchanged three frames later), 32 = the module asked for a search, 64 = it could not.  Header: taken / untaken = steps
# straight that moved the lens / did not move it at all.
f32 = lambda bits: struct.unpack('<f', struct.pack('<I', bits))[0]


def parse(data):
    magic, version = struct.unpack_from('<2I', data, 0)
    if magic != MAGIC: raise ValueError('not a movie AF file')
    if version not in HEADER: raise ValueError(f'version {version}')
    h = struct.unpack_from(HEADER[version], data, 0)
    if h[2] != struct.calcsize(RECORD): raise ValueError(f'record size {h[2]}')
    head = dict(version=h[1], records=h[3], dropped=h[4], files=h[5], stops=h[7], header_bytes=h[8], frame_rate=f32(h[9]), lens_speed=list(h[10:15]), lens_unit=h[15],
                aperture=f32(h[16]), flags=h[17], frames=h[18], forced=h[19], reversals=h[20], sized=h[21], distrusts=h[22], lens_index=h[23], lens_quiet=h[24], motor_ordinary=h[25],
                restarts=h[28] if version >= 5 else 0, servos=h[29] if version >= 7 else 0, vetoes=h[30] if version >= 7 else 0,
                taken=h[31] if version >= 8 else 0, untaken=h[32] if version >= 8 else 0, direct_dead=h[33] if version >= 8 else 0, veto_off=h[34] if version >= 8 else 0)
    head['probes'] = []
    if version >= 12:              # the first large steps of the recording, frame by frame, with what else the phase block says
        def zframe(q):
            return dict(moved=q[0], median=q[1], direction=q[2] & 1, areas=(q[2] >> 1) & 7, valid=bool(q[2] & 16), new=bool(q[2] & 32), age=q[3], d14=q[4], dirs=q[5], quality=q[6],
                        mid=list(q[7:12]), val=list(q[12:17]), rel=list(q[17:22]))
        k = 36
        for i in range(PROBES):
            q = h[k:k + 7 + 23 * (PROBE_FRAMES + 1)]; k += 7 + 23 * (PROBE_FRAMES + 1)
            if i < h[35]: head['probes'].append(dict(tick=q[0], units=q[1], by=q[2], direction=q[3], pre=zframe(q[7:30]), frames=[zframe(q[30 + 23 * j:53 + 23 * j]) for j in range(PROBE_FRAMES)]))
    rows = [dict(zip(FIELDS, struct.unpack_from(RECORD, data, h[8] + i * h[2]))) for i in range(h[3])]
    return head, rows


def probe_lines(head, full=False):
    """one line per step followed frame by frame: when the lens stopped, and the results that appeared after the step was sent;
    full: every frame, with the factory's own targets (middle per area, signed, from the block's lens position) and the block's lens position less the lens's own"""
    out = []
    for q in head['probes']:
        fr = q['frames']; stop = next((j + 1 for j in range(len(fr) - 1) if fr[j]['moved'] and fr[j]['moved'] == fr[j + 1]['moved']), None)
        res = ' '.join(f"+{j + 1}:{'F' if f['direction'] else 'N'}{f['median']}/{f['areas']}" for j, f in enumerate(fr) if f['new'])
        out.append(f"  step {q['units']:3} {'far ' if q['direction'] else 'near'} by {q['by']:3} at frame {q['tick']}: lens stopped at +{stop} ({fr[-1]['moved']} units); new results at {res}")
        if full:
            for name, f in [('+0', q['pre'])] + [(f'+{j + 1}', f) for j, f in enumerate(fr)]:
                out.append(f"      {name:>3} moved {f['moved']:4} {'new' if f['new'] else '   '} {'F' if f['direction'] else 'N'}{f['median']:4}/{f['areas']} age {f['age']:2} | block position - lens {f['d14']:5} | dirs {f['dirs']:05b} good {f['quality']:05b} | factory middle {f['mid']} | values {f['val']} rel {f['rel']}")
    return out


def moves(rows):
    """stretches in which the lens's own position changes: (start s, seconds, units, units/s, speed and motor setting the lens control stored)"""
    rows = [r for r in rows if r['phase_of_step'] != STANDBY]
    out, i = [], 0
    while i + 1 < len(rows):
        if rows[i + 1]['lens_real'] == rows[i]['lens_real']: i += 1; continue
        j = i
        while j + 1 < len(rows) and rows[j + 1]['lens_real'] != rows[j]['lens_real'] and (rows[j + 1]['lens_real'] - rows[j]['lens_real']) * (rows[i + 1]['lens_real'] - rows[i]['lens_real']) > 0: j += 1
        dt = (rows[j]['t_us'] - rows[i]['t_us']) / 1e6; units = abs(rows[j]['lens_real'] - rows[i]['lens_real'])
        if dt > 0: out.append((rows[i]['t_us'] / 1e6, dt, units, units / dt, rows[j]['lens_speed'], rows[j]['motor']))
        i = j + 1
    return out


def first_fast(cur):
    """seconds from the first record of a search to its first fast step (None: none)"""
    return next(((r['t_us'] - cur[0]['t_us']) / 1e6 for r in cur if r['marks'] & 1), None)


def searches(rows):
    """one line per search: from the first focusing record after a standby (or a pause) to the last before the next"""
    out, cur = [], []
    def close():
        if len(cur) >= 4:
            p0, p1 = cur[0]['lens_real'], cur[-1]['lens_real']; d = 1 if p1 >= p0 else -1
            fast = [(r['step'], r['lens_speed'] if r['lens_speed'] > 120 else 0) for r in cur if r['marks'] & 1]
            out.append(dict(start=cur[0]['t_us'] / 1e6, seconds=(cur[-1]['t_us'] - cur[0]['t_us']) / 1e6, begin=p0, end=p1, fast=fast, forced=sum(1 for r in cur if r['forced']), wait=first_fast(cur),
                            past=max((r['lens_real'] - p1) * d for r in cur), first_value=next((r['median'] for r in cur if r['total_valid'] and r['reliable'] >= 3), 0), last_state=cur[-1]['phase_of_step']))
        cur.clear()
    last = None
    for r in rows:
        if r['phase_of_step'] == STANDBY or (last is not None and r['t_us'] - last > 300000): close()
        if r['phase_of_step'] != STANDBY: cur.append(r)
        last = r['t_us']
    close()
    return out


def standbys(rows):
    """standby stretches seen in the records: (start s, seconds, largest median with three reliable areas, new search asked for by the module)"""
    out, cur = [], []
    for r in rows + [None]:
        if r is not None and r['phase_of_step'] == STANDBY and (not cur or r['count'] > cur[-1]['count']): cur.append(r); continue
        if cur: out.append((cur[0]['t_us'] / 1e6, (cur[-1]['t_us'] - cur[0]['t_us']) / 1e6, max((x['median'] for x in cur if x['reliable'] >= 3), default=0), any(x['marks'] & 32 for x in cur), any(x['marks'] & 64 for x in cur),
                            [(-x['step'] if x['total_direction'] else x['step']) for x in cur if x['marks'] & 128], sum(x['cap'] for x in cur if x['marks'] & 16)))
        cur = [r] if r is not None and r['phase_of_step'] == STANDBY else []
    return out


def summary(head, rows):
    f = head['flags']
    out = [f"version {head['version']}, step size {'on' if f & 1 else 'off'}, direction {'on' if f & 2 else 'off'}, standby {'on' if f & 8 else 'off'}, keeping the focus {'on' if f & 16 else 'off'}; {head['frames']} focusing frames, "
           f"{head['records']} records ({head['dropped']} dropped); votes replaced {head['forced']} (turns {head['reversals']}), fast steps {head['sized']}, trust lost {head['distrusts']}, searches asked for from standby {head['restarts']}, steps straight from standby {head['servos']}" + (f" (the lens moved: {head['taken']}, did not move at all: {head['untaken']}{'; none any more in this recording' if head['direct_dead'] else ''})" if head['version'] >= 8 else '')
           + f", searches of the camera refused {head['vetoes']}" + (' (nothing refused any more: a search let through as a test ended somewhere else)' if head['veto_off'] else ''),
           f"frame rate {head['frame_rate']:.2f}, camera speeds {head['lens_speed']}, aperture {head['aperture']:.2f}; lens index {head['lens_index']}, recording property {head['lens_quiet']}, ordinary motor setting {head['motor_ordinary']}"]
    m = moves(rows)
    if m:
        fast = sorted(x[3] for x in m if x[2] >= 12)
        out.append(f"lens moves seen: {len(m)}; of 12 units or more: {len(fast)}" + (f", real speed median {fast[len(fast) // 2]:.0f}, fastest {fast[-1]:.0f} units/s" if fast else '')
                   + f"; speeds the lens control stored: {sorted({x[4] for x in m})[:12]}; motor settings: {sorted({x[5] for x in m})}")
    for s in searches(rows):
        out.append(f"  search {s['start']:6.2f} s, {s['seconds']:4.2f} s: {s['begin']:5} -> {s['end']:5} ({abs(s['end'] - s['begin']):3} units), first value {s['first_value']:3}, fast steps {s['fast']}{'' if s['wait'] is None else ' (the first after %.2f s)' % s['wait']}, votes replaced {s['forced']}, past the end {s['past']:3}, last state {s['last_state']}")
    for t, d, peak, asked, refused, steps, vetoed in standbys(rows):
        out.append(f"  standby {t:6.2f} s, {d:5.2f} s: largest value {peak}" + (', the module asked for a new search' if asked else '') + (', (asked and refused)' if refused else '')
                   + (f', steps straight there {steps}' if steps else '') + (f', searches refused {vetoed}' if vetoed else ''))
    out += probe_lines(head)
    for r in rows:
        if r['forced']: out.append(f"  {r['t_us'] / 1e6:6.2f} s: vote {r['stock_verdict']} replaced by {r['forced']} (median {r['median']}, {r['reliable']} areas, travel direction now {r['direction']})")
        if r['marks'] & 4: out.append(f"  {r['t_us'] / 1e6:6.2f} s: trust lost (median {r['median']})")
        if r['phase_of_step'] == STANDBY and r['marks'] & 1: out.append(f"  {r['t_us'] / 1e6:6.2f} s: a step straight was not taken by the lens")
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('paths', nargs='+', type=Path); ap.add_argument('--csv', type=Path); ap.add_argument('--rows', action='store_true')
    a = ap.parse_args()
    files = [f for p in a.paths for f in (sorted(p.glob('VQ*.BIN')) if p.is_dir() else [p])]
    if not files: sys.exit('no VQ*.BIN file')
    for f in files:
        head, rows = parse(f.read_bytes())
        print(f.name); [print('  ' + line) for line in summary(head, rows)]
        if a.rows:
            [print(line) for line in probe_lines(head, True)]
            for r in rows:
                if r['phase_of_step'] == STANDBY:
                    extra = ''
                    if head['version'] >= 12:
                        s16 = lambda v: v - 65536 if v > 32767 else v
                        extra = ' | block position - lens %d, factory middle %d, dirs %s good %s' % (s16(r['base']), s16(r['lens_speed']), format(r['last_amount'] & 31, '05b'), format(r['last_amount'] >> 8 & 31, '05b'))
                    print('  t%7.3f f%5d real%5d standby frame%5d | td%d v%d on%d rel%d in-focus areas %d med%4d age%3d | row%3d follow%3d | step%4d by%4d share%4d worth%4d refused%3d settle%3d | camera: watching %d scene %d asked %d | lens held by %d%s | marks %d%s'
                          % (r['t_us'] / 1e6, r['frame'], r['lens_real'], r['count'], r['total_direction'], r['total_valid'], r['running'], r['reliable'], r['count_before'], r['median'], r['age'], r['run'], r['own_count'],
                             r['step'], r['median_used'], r['wanted'], r['moved'], r['cap'], r['settle'], r['verdict'], r['direction'], r['result'], r['lens'] & 255,
                             ''.join(t for b, t in ((256, ' (for a step)'), (512, ' no-steps'), (1024, ' no-refusing'), (2048, ' steps-paused')) if r['lens'] & b), r['marks'], extra))
                    continue
                print('  t%7.3f f%5d real%5d cnt%5d e5=%d dir%d | td%d v%d rel%d med%4d age%3d left%4d | moved%4d climb%3d step%3d want%2d c78 %2d own %2d | vote %3d->%d run%2d | speed%5d motor%2d amount%4d | settle%3d distrust%2d camp%2d marks %d'
                      % (r['t_us'] / 1e6, r['frame'], r['lens_real'], r['lens'], r['phase_of_step'], r['direction'], r['total_direction'], r['total_valid'], r['reliable'], r['median'], r['age'], r['median_used'],
                         r['moved'], r['steps_in_climb'], r['step'], r['wanted'], r['count'], r['own_count'], r['stock_verdict'], r['forced'], r['run'], r['lens_speed'], r['motor'], r['last_amount'], r['settle'], r['distrust'], r['campaign'], r['marks']))
        if a.csv:
            a.csv.mkdir(parents=True, exist_ok=True)
            with open(a.csv / (f.stem + '.csv'), 'w', newline='') as o:
                w = csv.DictWriter(o, fieldnames=FIELDS); w.writeheader(); w.writerows(rows)


if __name__ == '__main__':
    main()
