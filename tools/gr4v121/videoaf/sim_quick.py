# SPDX-License-Identifier: GPL-2.0-only
"""A closed loop around the camera's real travel-state and lens-move code (and, for a patched image, the module and
its stubs), with a made-up lens, phase module and contrast vote.  Not a prediction of the camera: a check that the
pieces work together without swinging to and fro, and a comparison of builds under the same assumptions.

usage: sim_quick.py OFFICIAL_RTOS.bin PATCHED_RTOS.bin [--trace D R LAG PERIOD WRONG PREROLL [PHASE]]

Assumptions (from the camera's recordings where there are any):
  lens      a move of A units at v units/s takes ceil(A / v x 60) frames; v = 120 while recording unless the move is
            marked (then the marked speed, at most 2500); the wobbling module looks again one frame after the lens stops
  phase     a new result every PERIOD frames (camera: 3 .. 4, now and then 8), showing the lens as it was LAG frames
            before (camera: 4 .. 6; the module allows for 8); value = distance / R (R = 0.28 .. 0.48 measured; 0.37
            typical), +-8 % noise, direction right, all areas reliable
  start     PREROLL frames in which the phase module already shows the new subject before the camera travels (the
            camera's start state takes four frames and more); 0: the first result comes with the first travel frame.
            The first travel step is the first of a climb (the camera sets its count anew there)
  vote      3 while the distance shrinks; 0 once the focus is passed and the distance grows; against the direction of
            travel after three steps away from a focus not yet passed (the camera's contrast logic, roughly)
  ramp      the camera's own count goes up every second step while the focus is more than 40 units away"""
import json, math, random, struct, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cam import *
from layout import layout as read_layout

FPS, IN_FOCUS = 60, 6


class World:
    def __init__(self, cam, distance, ratio, lag, wrong, seed=1, phase='right', jump=None, period=4):
        self.c, self.ratio, self.lag, self.period = cam, ratio, lag, period
        self.phase_kind, self.jump = phase, jump            # phase: 'right', 'wrong' (direction inverted), 'none' (no reliable area); jump: (frame, new distance from the start)
        self.p, self.focus = 1000.0, 1000.0 + distance       # the focus is in direction 1
        self.history = [self.p] * 40
        self.move = None; self.done_at = -9; self.t = 0
        self.rng = random.Random(seed)
        self.leg_side = None; self.last_distance = None; self.away = 0
        self.log = []; self.moves = []; self.fast = []; self.last_direction = None; self.turns = 0
        cam.wobbler(base=3, cap=48, direction=0 if wrong else 1, climb=0)
        cam.native(VOTE, self.vote); cam.native(AREA_A, lambda c: 3); cam.native(AREA_B, lambda c: 0)
        cam.native(RAMP_OK, lambda c: 0 if abs(self.focus - self.p) > 40 else 1)
        cam.native(LENS_KIND, lambda c: 0); cam.native(LENS_590A, lambda c: 0); cam.native(LENS_POSITION, lambda c: -int(round(self.p)))
        cam.native(LENS_MOVE, self.lens_move)

    def vote(self, c):
        distance = abs(self.focus - self.p); side = self.focus > self.p
        if self.leg_side is None: self.leg_side = side; self.last_distance = distance; self.away = 0; return 3
        passed = side != self.leg_side
        growing = distance > self.last_distance
        self.last_distance = distance
        if passed and growing: return 0
        if not passed and growing:
            self.away += 1
            if self.away >= 3: return 1 if c.r8(W + 0x21) == 1 else 2
        return 3

    def lens_move(self, c):
        amount, speed, direction = c.r(2), c.r(3), c.r32(c.r(13))
        v = min(speed & 0x7fff, 2500) if speed & 0x8000 else min(speed, 120)
        frames = max(1, math.ceil(amount / v * FPS))
        if self.last_direction is not None and direction != self.last_direction:
            self.turns += 1; self.leg_side = None
        self.last_direction = direction
        self.move = [self.p, self.p + (amount if direction == 1 else -amount), frames, 0]
        self.moves.append((self.t, amount, v, direction))
        if speed & 0x8000: self.fast.append(amount)
        return 1

    def frame_start(self):
        c = self.c
        if self.move:
            m = self.move; m[3] += 1
            self.p = m[0] + (m[1] - m[0]) * m[3] / m[2]
            if m[3] >= m[2]:
                self.move = None; self.done_at = self.t
                c.w8(W + 9, 1); c.w32(W + 0x134, int(round(self.p))); c.w32(W + 0x130, int(round(self.p)))
        self.history.append(self.p)
        if self.jump and self.t == self.jump[0]:
            self.old_focus, self.focus = self.focus, 1000.0 + self.jump[1]; self.jump_seen = self.t + self.lag
            self.leg_side = None
        if self.t % self.period: return                     # the result standing stays
        seen = self.history[-1 - self.lag]
        focus = self.old_focus if getattr(self, 'jump_seen', None) is not None and self.jump_seen > self.t else self.focus      # the phase module sees the new subject LAG frames late
        signed = (focus - seen) / self.ratio
        value = abs(signed)
        values = [max(0, int(value * (1 + self.rng.uniform(-0.08, 0.08)))) for _ in range(5)]
        direction = 1 if signed > 0 else 0
        if self.phase_kind == 'wrong': direction ^= 1
        c.phase(values, [200 if self.phase_kind == 'none' else 20] * 5, direction=direction)

    def may_evaluate(self): return self.move is None and self.t - self.done_at >= 1


def run(image, layout, distance, ratio, lag, wrong, frames=600, trace=False, phase='right', jump=None, period=4, preroll=0):
    c = Cam(image); w = World(c, distance, ratio, lag, wrong, phase=phase, jump=jump, period=period)
    tramp = c.trampoline()
    waiting = [True]
    if layout:
        def step(c):
            if not waiting[0] and w.may_evaluate(): c.mu.reg_write(UC_ARM_REG_PC, tramp); return None
            return 0
        c.native(STEP, step)
    c.w8(W + 0xe5, 0)                                       # the camera's start state: the module sees the phase results, nothing travels
    for t in range(-preroll, 0):
        w.t = t; w.frame_start()
        if layout: c.call(layout['wobbleStub'], O)
    c.w8(W + 0xe5, 5); waiting[0] = False
    reached = None; worst = 0.0
    for t in range(frames):
        w.t = t; w.frame_start()
        if layout: c.call(layout['wobbleStub'], O)
        elif w.may_evaluate(): c.call(tramp)
        miss = w.focus - w.p
        if jump and t < jump[0]: continue
        if reached is None and abs(miss) <= IN_FOCUS: reached = t
        if not jump and miss < -worst: worst = -miss
        if jump: worst = max(worst, abs(w.p - 1000.0) if phase == 'wrong' else 0)
        if trace: print('  t%3d p%7.1f miss%7.1f state %d dir %d count %2d step %3d vote %d %s' % (t, w.p, miss, c.r8(W + 0xe5), c.r8(W + 0x21), c.s32(W + 0xc78), c.r16(W + 0x1a), c.r8(W + 0xe6), w.moves[-1] if w.moves and w.moves[-1][0] == t else ''))
        if c.r8(W + 0xe5) != 5: break
    far = max(abs(q - 1000.0) for q in w.history)
    first_fast = next((m[0] for m in w.moves if m[2] > 120), None)
    return dict(reached=reached, peak=t if c.r8(W + 0xe5) != 5 else None, overshoot=worst, turns=w.turns, steps=len(w.moves), fast=list(w.fast), final_miss=abs(w.focus - w.p), farthest=far, first_fast=first_fast,
                state=struct.unpack_from('<I', bytes(c.mu.mem_read(SLOT, 4)))[0])


def main():
    official = Path(sys.argv[1]).read_bytes(); patched = Path(sys.argv[2]).read_bytes()
    layout = read_layout(patched)
    if '--trace' in sys.argv:
        i = sys.argv.index('--trace'); d, r, lag, period, wrong, preroll = int(sys.argv[i + 1]), float(sys.argv[i + 2]), int(sys.argv[i + 3]), int(sys.argv[i + 4]), int(sys.argv[i + 5]), int(sys.argv[i + 6])
        print(run(patched, layout, d, r, lag, wrong, trace=True, period=period, preroll=preroll, phase=sys.argv[i + 7] if len(sys.argv) > i + 7 else 'right')); return
    ms = lambda f: '   -' if f is None else '%4d' % round(f * 1000 / FPS)
    bad = []; gains = []; waits = {0: [], 8: []}
    print('distance  R    lag period start  seen before | camera alone (limit 48, lens 120/s)  | this build')
    print('                                             | in focus  peak found  past   turns   | fast step after  in focus  peak found  past   turns  steps  fast moves')
    for distance in (30, 80, 170, 280):
        for ratio in (0.28, 0.37, 0.48):
            for lag, period in ((5, 4), (6, 3), (8, 4), (5, 8), (10, 4)):
                for wrong in (0, 1):
                    for preroll in (0, 8):
                        k = dict(distance=distance, ratio=ratio, lag=lag, wrong=wrong, period=period)
                        a = run(official, None, **k); b = run(patched, layout, preroll=preroll, **k)
                        print(f"{distance:6}  {ratio:.2f}  {lag:4}  {period:4}   {'wrong' if wrong else 'right'}  {preroll:2} frames    | {ms(a['reached'])} ms   {ms(a['peak'])} ms  {a['overshoot']:5.1f}  {a['turns']:3}     |    {ms(b['first_fast'])} ms       {ms(b['reached'])} ms   {ms(b['peak'])} ms  {b['overshoot']:5.1f}  {b['turns']:3}   {b['steps']:3}   {b['fast']}")
                        case = (distance, ratio, lag, period, wrong, preroll)
                        if b['reached'] is None or b['peak'] is None: bad.append(('never in focus',) + case)
                        elif b['turns'] > (2 if wrong else 1): bad.append(('swings',) + case + (b['turns'],))
                        elif b['overshoot'] > max(20, 0.15 * distance): bad.append(('overshoot',) + case + (b['overshoot'],))
                        elif a['reached'] is not None and b['reached'] > a['reached'] + 6: bad.append(('slower than the camera alone',) + case)
                        elif len(b['fast']) > (1 if distance <= 200 else 2): bad.append(('more fast moves than expected',) + case + (b['fast'],))
                        if a['reached'] is not None and b['reached'] is not None: gains.append((a['reached'] - b['reached']) / FPS)
                        if distance >= 80 and b['first_fast'] is not None: waits[preroll].append(b['first_fast'])
    print('PROBLEMS: ' + repr(bad) if bad else 'no case swings, misses, is slower than the camera alone, or makes more than one fast move (two beyond 200 units)')
    gains.sort()
    print(f'in focus sooner than the camera alone: median {gains[len(gains) // 2]:.2f} s, least {gains[0]:.2f} s, most {gains[-1]:.2f} s ({len(gains)} cases)')
    for preroll, v in waits.items():
        v.sort()
        if v: print(f'frames from the first travel frame to the fast step, new subject seen {preroll} frames before (80 units and more): median {v[len(v) // 2]}, most {v[-1]}')
    print()
    print('other cases (result 5 frames behind, one every 4 frames, R 0.37)                 | camera alone            | this build')
    def line(name, **k):
        a = run(official, None, **k); b = run(patched, layout, **k)
        print(f"{name:76} | in focus {ms(a['reached'])} ms, turns {a['turns']} | in focus {ms(b['reached'])} ms, peak {ms(b['peak'])} ms, turns {b['turns']}, steps {b['steps']}, fast moves {b['fast']}, farthest from the start {b['farthest']:.0f}")
        return a, b
    for d in (80, 170):
        a, b = line(f'no reliable phase area, {d} units (the camera alone, by design)', distance=d, ratio=0.37, lag=5, wrong=0, phase='none')
        if b['reached'] != a['reached'] or b['fast']: bad.append(('no phase: not as the camera alone', d))
    a, b = line('the subject changes 6 frames after the start: 170 units ahead -> 100 units behind', distance=170, ratio=0.37, lag=5, wrong=0, jump=(6, -100))
    if b['reached'] is None or b['turns'] > 3: bad.append(('subject jumps behind', b))
    a, b = line('the subject changes 6 frames after the start: 60 units ahead -> 250 units ahead', distance=60, ratio=0.37, lag=5, wrong=0, jump=(6, 250))
    if b['reached'] is None or b['turns'] > 2: bad.append(('subject jumps ahead', b))
    a, b = line('the phase direction is wrong all the time (focus 170 units ahead)', distance=170, ratio=0.37, lag=5, wrong=0, phase='wrong', frames=1500)
    if b['peak'] is None or b['final_miss'] > 60 or b['farthest'] > 300: bad.append(('wrong phase: lost', b))
    a, b = line('the same, starting the wrong way', distance=170, ratio=0.37, lag=5, wrong=1, phase='wrong', frames=1500)
    if b['peak'] is None or b['final_miss'] > 60 or b['farthest'] > 300: bad.append(('wrong phase, wrong start: lost', b))
    print('PROBLEMS: ' + repr(bad) if bad else 'all of them end at the focus')
    if bad: sys.exit(1)


if __name__ == '__main__':
    main()
