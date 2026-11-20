# SPDX-License-Identifier: GPL-2.0-only
"""Keeping the focus without a search (module version 8), in a closed loop: the patched image's standby path (monitor
stub -> module -> the wobbling module's real lens move -> the real lens interface, which takes a move only from who
holds the lens) with a made-up lens control and phase module, the camera's own decision wanting a new search, and a
made-up search when one is let through or asked for.  Not a prediction of the camera: a check that the lens neither
swings nor creeps away, how the numbers in vafquick.c behave under the timing measured on the camera, and what
happens when the lens takes no step in standby (as on the camera with version 7, where nobody held it).

usage: sim_follow.py PATCHED_RTOS.bin [--trace CASE]

Assumptions:
  lens     held by nobody in standby and by the movie AF during a search (lens + 0x14, as the camera's code does it);
           a move of A units at v units/s takes ceil(A / v x 60) frames; v = the marked speed (at most 2500) or 120;
           a move asked while one is under way is refused (the camera's lens did that, 2026-11-13); lens='dead': the
           lens control takes the command and the lens does not move
  phase    a new result every PERIOD frames showing the lens LAG frames before (camera: 3 .. 4, now and then 8, and
           4 .. 6); value = distance / R with +-8 % per area and +-NOISE value units on all areas together (the
           camera's standby values at rest: mostly below 25, either sign), all areas reliable unless said otherwise
  curve    what the camera's recordings of version 8 showed instead of a straight line: near the focus a value unit is
           worth 0.18 lens units (up to 17 units away), beyond that R (the "worth" of the cases, 0.24 .. 0.51); for the
           far direction one straight line with R, 0.31 at least (the smallest of eight ways back on the camera); and
           `ramp` (case 8): the value of a new subject grows over that many frames (it comes into the frame), so the
           first results are too small
  camera   wants a new search in every standby frame from `wish[0]` to `wish[1]` (as it does while the picture keeps
           changing); a search let through or asked for begins two frames later, takes 30 frames at least and
           100 units/s, ends on the focus, and the lens is given back"""
import json, math, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cam import *
from layout import layout as read_layout

FPS, START = 60, 500.0


class Rest:
    def __init__(self, image, layout, ratio=0.37, lag=5, period=4, noise=12.0, seed=1, phase='right', lens='takes', wish=(0, 10 ** 9), curve=True, ramp=0, change=30, weak=0, jitter=0, far_ratio=None):
        self.c = c = Cam(image); self.L = layout
        self.ratio, self.lag, self.period, self.noise, self.kind, self.lens, self.wish = ratio, lag, period, noise, phase, lens, wish
        self.curve, self.ramp, self.change, self.weak, self.jitter, self.far_ratio = curve, ramp, change, weak, jitter, far_ratio
        self.p = START; self.focus = lambda t: START; self.history = [self.p] * 64
        self.move = None; self.moves = []; self.refused = 0; self.asked = 0; self.t = 0; self.searches = []; self.search = None; self.untaken = 0
        self.rng = random.Random(seed); self.areas = None      # areas: per-area focus offsets (None: all on the subject)
        c.wobbler()
        c.native(STEP, lambda c: 0); c.native(MONITOR, lambda c: 0); c.native(LENS_KIND, lambda c: 0); c.native(LENS_590A, lambda c: 0); c.native(LENS_STATE, lambda c: 0)
        c.native(LENS_POSITION, lambda c: int(round(self.p)))
        c.native(RESTART, self.restart)
        c.phase([5, 6, 4, 5, 7], [20] * 5); c.call(layout['wobbleStub'], O)     # one focusing frame: the module's state exists
        c.standby_lens(0)                                                       # that search has ended: nobody holds the lens
        c.native(LENS_COMMAND, self.lens_command); c.native(LENS_QUERY, lambda c: 4 if self.move else 0)   # (bits 2, 3: the lens is moving)

    def restart(self, c):
        self.asked += 1
        if self.search is None: self.search = [self.t + 2, None]; self.searches.append(self.t)
        return 1

    def lens_command(self, c):
        """0x539526D4 (lens control, 0, 0x8900, direction, amount, speed): 0 = taken"""
        amount, speed, d = c.r32(c.r(13)), c.r32(c.r(13) + 4), c.r(3)
        if self.move: self.refused += 1; return 1
        self.moves.append((self.t, amount, min(speed & 0x7fff, 2500) if speed & 0x8000 else min(speed, 120), d))
        if self.lens == 'dead': self.untaken += 1; return 0
        v = self.moves[-1][2]
        self.move = [self.p, self.p + (amount if d == 0 else -amount), max(1, math.ceil(amount / v * FPS)), 0]
        return 0

    def frame(self, t):
        c = self.c; self.t = t
        if self.move:
            m = self.move; m[3] += 1; self.p = m[0] + (m[1] - m[0]) * m[3] / m[2]
            if m[3] >= m[2]: self.move = None
        self.history.append(self.p)
        if t % self.period == 0:
            lag = self.lag + (self.rng.randint(0, self.jitter) if self.jitter else 0)      # (camera: a result is 3 .. 7 frames behind when it appears)
            seen = self.history[-1 - lag]; f = self.focus(t - lag); common = self.rng.uniform(-self.noise, self.noise)
            offs = self.areas(t - self.lag) if self.areas else [0] * 5
            def value(d):
                if not self.curve: return d / self.ratio
                a = abs(d)
                if d < 0: r = self.far_ratio or max(self.ratio, 0.31); v = a / r if a <= 17 else 17 / r + (a - 17) / r    # the far direction: one line, 0.31 at least
                else: v = a / 0.18 if a <= 17 else 17 / 0.18 + (a - 17) / self.ratio
                if self.ramp and self.change <= t - lag < self.change + self.ramp and a > 17: v *= (t - lag - self.change + 1) / self.ramp
                return v if d > 0 else -v
            signed = [value((f + o) - seen) * (1 + self.rng.uniform(-0.08, 0.08)) + common for o in offs]
            total = sorted(signed)[2]                           # the overall direction: that of the middle area
            direction = 0 if total > 0 else 1
            if self.kind == 'wrong': direction ^= 1
            rel = [200 if self.kind == 'none' else 20] * 5
            if self.weak and abs(f - seen) > self.weak: rel = [20, 20, 200, 200, 200]     # far from the focus only two areas are reliable (case 9)
            c.phase([min(65534, int(abs(v))) for v in signed], rel, direction=direction)
        if self.search and t >= self.search[0]:                 # a search: the camera holds the lens and brings it to the focus
            if self.search[1] is None:
                self.search[1] = t + max(30, int(abs(self.focus(t) - self.p) / 100 * FPS)); self.move = None
                c.w32(LENS + 0x14, 2); c.w8(O + 0x85cb, 0)
            left = self.search[1] - t
            self.p += (self.focus(t) - self.p) / max(1, left)
            c.call(self.L['wobbleStub'], O)
            if left <= 0: self.p = self.focus(t); c.w32(LENS + 0x14, 0); self.search = None
            return
        if self.wish[0] <= t < self.wish[1]:
            c.mu.reg_write(UC_ARM_REG_R5, O); c.call(self.L['askStub'], PARENT, 2, 2, 0)    # the camera's own decision asks
        c.call(self.L['monitorStub'], O, 0, 0, 0)


def run(image, layout, frames, focus=None, areas=None, trace=False, **k):
    w = Rest(image, layout, **k)
    if focus: w.focus = focus
    w.areas = areas
    err = []
    for t in range(frames):
        w.frame(t); e = w.focus(t) - w.p; err.append(e)
        if trace: print('  t%4d lens %7.1f focus %7.1f off %6.1f %s' % (t, w.p, w.focus(t), e, w.moves[-1] if w.moves and w.moves[-1][0] == t else ''))
    return w, err


def main():
    image = Path(sys.argv[1]).read_bytes(); layout = read_layout(image)
    bad = []
    ms = lambda f: '   -' if f is None else '%4d' % round(f * 1000 / FPS)
    TIMING = ((5, 4), (6, 3), (8, 4), (5, 8), (7, 4))      # (frames behind, frames between results); the camera: 3 .. 7 behind, perhaps 8

    print('1. at rest, in focus, 20 s (the camera asking for a search every frame)')
    for noise in (8.0, 15.0, 25.0):
        for lag, period in TIMING:
            w, err = run(image, layout, 1200, noise=noise, lag=lag, period=period, seed=3)
            print(f'   noise +-{noise:4.0f}  result every {period} frames, {lag} behind: lens moves {len(w.moves)}, farthest from the focus {max(abs(e) for e in err):4.1f}, searches let through at {[round(t / FPS, 1) for t in w.searches]} s')
            if noise <= 15 and (len(w.moves) > 2 or max(abs(e) for e in err) > 10): bad.append(('restless at rest', noise, lag, period, len(w.moves)))
            if len(w.searches) > 2 or (w.searches and w.searches[0] < 180): bad.append(('searches let through at rest', noise, lag, period, w.searches))

    print('2. the subject is suddenly somewhere else (every step takes 0.24 of the value)')
    print('   distance  worth  timing    | first step after  within 8 units after  steps (units, + nearer / - farther)            past the focus  searches let through')
    worst_time = 0; worst_past = 0.0
    for distance in (15, 30, 60, 110, 200, 320, -30, -110, -320):
        for ratio in (0.24, 0.30, 0.37, 0.45, 0.51):
            for lag, period in TIMING:
                jump = 30
                w, err = run(image, layout, 400, focus=lambda t, d=distance: START + (d if t >= 30 else 0), ratio=ratio, lag=lag, period=period, wish=(30, 180))
                after = err[jump:]
                reach = next((i for i in range(len(after)) if all(abs(e) <= 8 for e in after[i:i + 30])), None)
                past = max([(-e if distance > 0 else e) for e in after] + [0.0])
                first = w.moves[0][0] - jump if w.moves else None
                steps = [(-m[1] if m[3] else m[1]) for m in w.moves]
                print(f"   {distance:5}     {ratio:.2f}   {period}/{lag:<2}      | {ms(first)} ms            {ms(reach)} ms             {str(steps):46} {past:5.1f}          {w.asked}")
                if reach is None: bad.append(('never within 8 units', distance, ratio, lag, period))
                elif abs(distance) >= 30:
                    worst_time = max(worst_time, reach)
                if past > max(12.0, 0.12 * abs(distance)): bad.append(('past the focus', distance, ratio, lag, period, past))
                worst_past = max(worst_past, past)
                if w.asked: bad.append(('a search let through', distance, ratio, lag, period))
                large = [x for x in steps if abs(x) >= 5]            # (steps below 5 units are the trim at rest)
                if sum(1 for a, b in zip(large, large[1:]) if a * b < 0) > 1: bad.append(('to and fro', distance, ratio, lag, period, steps))
    print(f'   longest time to within 8 units: {ms(worst_time)} ms; farthest past the focus: {worst_past:.1f} units')

    print('3. the same change a second and third time in one recording, worth 0.45, result every 4 frames, 5 behind')
    f3 = lambda t: START + (110 if 30 <= t < 300 or t >= 570 else 0)
    w, err = run(image, layout, 840, focus=f3, ratio=0.45, wish=(30, 180))
    for name, a in (('first', 30), ('second (back)', 300), ('third', 570)):
        seg = err[a:a + 270]; reach = next((i for i in range(len(seg)) if all(abs(e) <= 8 for e in seg[i:i + 30])), None)
        steps = [(-m[1] if m[3] else m[1]) for m in w.moves if a <= m[0] < a + 270]
        print(f'   {name:14} steps {steps}, within 8 units after {ms(reach)} ms')
        if reach is None: bad.append(('3: never in focus', name))

    print('4. the subject moves steadily (walking round it): 2 s at 40 units/s nearer, 1 s still, 2 s at 40 units/s farther')
    def walk(t):
        if t < 60: return START
        if t < 180: return START + (t - 60) * 40 / 60
        if t < 240: return START + 80
        if t < 360: return START + 80 - (t - 240) * 40 / 60
        return START
    for ratio in (0.30, 0.45):
        for lag, period in ((5, 4), (8, 4), (5, 8)):
            w, err = run(image, layout, 480, focus=walk, ratio=ratio, lag=lag, period=period, wish=(60, 400))
            e = [abs(x) for x in err[60:400]]
            print(f'   worth {ratio:.2f}, timing {period}/{lag}: lens moves {len(w.moves)}, off the focus on average {sum(e) / len(e):4.1f}, at most {max(e):4.1f}; at the end {abs(err[-1]):.1f}; searches let through at {[round(t / FPS, 1) for t in w.searches]} s (the camera wants one from 1.0 s to 6.7 s)')
            if max(e) > 35 or abs(err[-1]) > 10 or len(w.searches) > 1 or (w.searches and w.searches[0] < 60 + 180): bad.append(('4: walking', ratio, lag, period, max(e), w.searches))

    print('5. the subject slips out of the frame: all areas read the background 150 units farther')
    for hold in (6, 10, 40, 120):
        w, err = run(image, layout, 400, focus=lambda t, h=hold: START - (150 if 60 <= t < 60 + h else 0), wish=(60, 60 + hold + 60))
        moved = max(abs(x - START) for x in w.history)
        back = abs(w.p - START)
        print(f'   for {hold:3} frames ({hold * 1000 // 60:4} ms): lens moves {len(w.moves)}, farthest from the subject {moved:5.1f}, at the end {back:4.1f} from it; searches let through {w.asked}')
        if hold <= 10 and w.moves: bad.append(('5: followed a slip of', hold))
        if hold >= 40 and moved < 100: bad.append(('5: did not go to the background after', hold))
        if back > 10 or w.asked: bad.append(('5: not back on the subject', hold))
    print('   ... while the subject moves away slowly (20 units/s) and slips out for 10 frames in the middle (all areas read the background, 150 units farther)')
    def slow(t): return START - max(0, min(t, 300) - 60) * 20 / 60
    w, err = run(image, layout, 400, focus=lambda t: slow(t) - (150 if 180 <= t < 190 else 0), wish=(60, 230))
    off = max(abs(slow(t) - x) for t, x in enumerate(w.history[64:]))
    print(f'   lens moves {len(w.moves)}, farthest from the subject {off:5.1f}, at the end {abs(slow(399) - w.p):4.1f} from it; searches let through {w.asked}')
    if off > 30 or abs(slow(399) - w.p) > 10 or w.asked: bad.append(('5: a slip while following', off))
    print('   ... and when two of the five areas stay on the subject (the others read the background, 150 units farther, for 5 s)')
    w, err = run(image, layout, 400, areas=lambda t: [-150, -150, 0, 0, -150] if 60 <= t < 360 else [0] * 5, wish=(60, 230))
    print(f'   lens moves {len(w.moves)}, searches let through {w.asked}')
    if w.moves or w.asked: bad.append(('5: left a subject that two areas still saw',))
    print('   ... and a nearer thing comes into three of the five areas (150 units nearer)')
    w, err = run(image, layout, 300, areas=lambda t: [150, 150, 0, 0, 150] if t >= 60 else [0] * 5, wish=(60, 230))
    went = w.moves[0][0] - 60 if w.moves else None
    print(f'   first step after {ms(went)} ms, lens ends {w.p - START:5.1f} units nearer')
    if went is None or went > 30 or abs(w.p - START - 150) > 12: bad.append(('5: did not take the nearer subject', went, w.p))

    print('6. phase data that cannot be trusted')
    w, err = run(image, layout, 900, focus=lambda t: START + (110 if t >= 30 else 0), phase='wrong')
    far = max(START - x for x in w.history)
    print(f'   direction always wrong: lens moves {len(w.moves)} ({[(-m[1] if m[3] else m[1]) for m in w.moves]}), farthest the wrong way {far:.0f}; searches {len(w.searches)}, the first {ms(w.searches[0] - 30 if w.searches else None)} ms after the change (the camera\'s own search takes over); at the end {abs(err[-1]):.1f} from the focus')
    if far > 420 or len(w.moves) > 2 or not w.searches or abs(err[-1]) > 8: bad.append(('6: wrong phase', len(w.moves), far, w.searches))
    w, err = run(image, layout, 300, focus=lambda t: START + (110 if t >= 30 else 0), phase='none')
    print(f'   no reliable area at all: lens moves {len(w.moves)}; searches let through {w.asked} of 300 (from the 31st frame)')
    if w.moves or not w.asked: bad.append(('6: no phase', len(w.moves), w.asked))
    print('7. the lens takes no step in standby (what the camera did with version 7): the subject suddenly somewhere else at 0.5 s, and back at 5 s')
    print('   distance  worth  timing    | step tried  search asked for after  within 8 units after | second change: steps tried, search asked for after, within 8 units after')
    for distance in (30, 60, 110, 320, -110, -320):
        for ratio in (0.24, 0.37, 0.51):
            for lag, period in ((5, 4), (8, 4), (5, 8)):
                f7 = lambda t, d=distance: START + (d if 30 <= t < 300 else 0)
                w, err = run(image, layout, 600, focus=f7, ratio=ratio, lag=lag, period=period, lens='dead', wish=(30, 180))
                first = [x for x in w.searches if x < 300]; second = [x for x in w.searches if x >= 300]
                tried1 = [m for m in w.moves if m[0] < 300]; tried2 = [m for m in w.moves if m[0] >= 300]
                reach = lambda a: next((i for i in range(len(err) - a) if all(abs(e) <= 8 for e in err[a + i:a + i + 30])), None)
                r1, r2 = reach(30), reach(300)
                print(f"   {distance:5}     {ratio:.2f}   {period}/{lag:<2}      | {len(tried1)}           {ms(first[0] - 30 if first else None)} ms                 {ms(r1)} ms               | {len(tried2)}, {ms(second[0] - 300 if second else None)} ms, {ms(r2)} ms")
                large = abs(distance) / ratio >= 110                        # the module asks from a value of 100; below that the camera's own wish decides (let through from 60)
                if len(tried1) > 1 or tried2: bad.append(('7: more than one step tried', distance, ratio, lag, period, len(w.moves)))
                if large and (not first or first[0] - 30 > 45 or r1 is None): bad.append(('7: no search soon after the untaken step', distance, ratio, lag, period, first))
                if abs(distance) / max(ratio, 0.31) >= 110 and (not second or second[0] - 300 > (45 if distance > 0 else 30) or r2 is None): bad.append(('7: second change', distance, ratio, lag, period, second))
                if len(w.searches) > 3: bad.append(('7: searches', distance, ratio, lag, period, w.searches))
    print('8. the camera\'s curve (a value unit worth 0.18 lens units near the focus, R beyond 17 units), the subject suddenly somewhere else, its value growing over `ramp` frames')
    print('   distance  R     ramp  timing | first step after  within 8 units after  steps                                    past the focus')
    worst8 = 0.0; times8 = []
    for distance in (30, 60, 110, 173, -60, -110, -186):
        for ratio in (0.25, 0.35, 0.50):
            for ramp in (0, 20):
                for lag, period in ((5, 4), (8, 4), (5, 8)):
                    w, err = run(image, layout, 400, focus=lambda t, d=distance: START + (d if t >= 30 else 0), ratio=ratio, lag=lag, period=period, wish=(30, 180), ramp=ramp)
                    after = err[30:]
                    reach = next((i for i in range(len(after)) if all(abs(e) <= 8 for e in after[i:i + 30])), None)
                    past = max([(-e if distance > 0 else e) for e in after] + [0.0])
                    steps = [(-m[1] if m[3] else m[1]) for m in w.moves]
                    print(f"   {distance:5}     {ratio:.2f}  {ramp:3}   {period}/{lag:<2}   | {ms(w.moves[0][0] - 30 if w.moves else None)} ms            {ms(reach)} ms             {str(steps):40} {past:5.1f}")
                    if reach is None: bad.append(('8: never within 8 units', distance, ratio, ramp, lag, period))
                    else: times8.append(reach)
                    if past > max(8, 0.06 * abs(distance)): bad.append(('8: past the focus', distance, ratio, ramp, lag, period, past, steps))
                    if w.searches: bad.append(('8: a search', distance, ratio, ramp, lag, period))
                    worst8 = max(worst8, past)
    times8.sort()
    print(f'   farthest past the focus: {worst8:.1f} units; time to within 8 units: median {ms(times8[len(times8) // 2])} ms, longest {ms(times8[-1])} ms')
    print('9. only two of the five areas are reliable further than 40 units from the focus (camera, version 10: the background after the hand had gone), the camera wanting a search for 2.5 s')
    for distance in (-110, -140, -200, 110):
        for ratio in (0.31, 0.40):
            for lag, period in ((5, 4), (8, 4), (5, 8)):
                w, err = run(image, layout, 400, focus=lambda t, d=distance: START + (d if t >= 30 else 0), ratio=ratio, lag=lag, period=period, wish=(30, 180), weak=40)
                after = err[30:]
                reach = next((i for i in range(len(after)) if all(abs(e) <= 8 for e in after[i:i + 30])), None)
                past = max([(-e if distance > 0 else e) for e in after] + [0.0])
                steps = [(-m[1] if m[3] else m[1]) for m in w.moves]
                print(f"   {distance:5}  worth {ratio:.2f}  timing {period}/{lag:<2} | first step after {ms(w.moves[0][0] - 30 if w.moves else None)} ms, within 8 units after {ms(reach)} ms, steps {steps}, past the focus {past:.1f}, searches {len(w.searches)}")
                # (a search after the step is the camera's turn: what is left reads less than 150 from two areas, which the module does not act on)
                if reach is None or past > 12 or not w.moves or w.moves[0][0] - 30 > 50 or (w.searches and w.searches[0] < w.moves[0][0]): bad.append(('9: two areas', distance, ratio, lag, period, steps, w.searches))
    print('PROBLEMS: ' + repr(bad) if bad else 'no case swings, creeps away, passes the focus by more than 12 units (12 % of a long way), lets a search through while the phase data is usable, or fails to end within 8 units')
    if bad: sys.exit(1)


if __name__ == '__main__':
    if '--trace' in sys.argv:
        image = Path(sys.argv[1]).read_bytes(); layout = read_layout(image)
        d, ratio, lag, period = int(sys.argv[4]), float(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7])
        w, err = run(image, layout, 300, focus=lambda t: START + (d if t >= 30 else 0), ratio=ratio, lag=lag, period=period, trace=True)
        print(w.moves)
    else:
        main()
