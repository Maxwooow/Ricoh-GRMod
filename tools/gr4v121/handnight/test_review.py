# SPDX-License-Identifier: GPL-2.0-only
"""mf18: the stock review chain after a shot (the research notes T7o), run in the emulator on the base build and on the
test build (the stock code is the same in both: the module only writes CaptureImageModel +0x27, test_night section 6):
  1. QUICK_VIEW_READY at CIM (0x533EB434: +0x24 only if +0x27), CaptureReadyModel's decision 0x533A30A0 / 0x533A2FC4 (review
     time CUR+0x1458, +0x24, the shooting screen 0x08000000) -> event 0x94 (the review screen) or 0xC8, and the App's 0xC8 handler
     0x5325D934 (StopReview 0x533EB020 only if +0x27: CMD_PLAYBACK_DIRECT_AND_QUICK_VIEW_STOP 0x4441100C to the playback queue).
     First the camera's mf13..mf17 state, +0x27 = 0 at the group's end: 0xC8, nothing posted to the playback task (the picture
     stays, as on the camera); then +0x27 = 1 (what REVIEW_ARM writes): 0x94 for a review time of 0.5 / 2 s and for "hold", 0xC8 +
     the stop for "off", 0xC8 + the stop if another screen is up;
  2. the review controller (QuickViewController, sub-screen +0x170 = screen id - 0x0800000D): its timer start 0x531EB780 (AppTimer
     0x53261A4C with the review time, none for "hold", the shooting screen at once for "off") and the timer's expiry 0x531EB534
     (the screen change 0x178 to 0x08000000, flag +0x184); a multi-exposure sub-screen (5) starts the timer but changes nothing;
  3. the review screen's exit 0x531EB828: CIM's review stop 0x533EB8A4 (0x531EB870) -> StopReview, the playback stop posted, CIM
     +0x27 / +0x24 cleared; with +0x27 = 0 (mf17) nothing posted.
Replaced (blind spots): the playback queue post 0x5326356C and the AppTimer start 0x53261A4C (recorded); the playback task, the
screen change itself, the display and the App's dispatcher; in the exit, its call 0x533BD834 into another model (events are recorded as posted, not delivered).  The CaptureReadyModel
is a zeroed stand-in (+8 = 0, +0xEE0 = 0), the review controller a zeroed object with its sub-screen byte.
usage: test_review.py BASE_RTOS TEST_RTOS"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sim
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import *

BASE_RTOS, TEST_RTOS = sys.argv[1:3]
fails = 0
def check(name, ok, detail=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name + (('  ' + detail) if detail and not ok else '')); fails += not ok

CIM_G, CIM, MOD_G, PB_G, PB_POST = 0x55083240, 0x55083138, 0x55083244, 0x5508317C, 0x5326356C
APPTIMER = 0x53261A4C
REVIEW_T = sim.CUR + 0x1458
CRM, QV = sim.OBJ + 0x3A00000, sim.OBJ + 0x3A10000
STOP = 0x4441100C


def cam(rtos):
    c = sim.Cam(rtos)
    c.pb, c.timers = [], []
    def pb(uc, *_):
        c.pb.append(c.reg(UC_ARM_REG_R1)); c._ret(0)
    def tm(uc, *_):
        c.timers.append((c.reg(UC_ARM_REG_R1), c.reg(UC_ARM_REG_R2))); c._ret(sim.OBJ + 0x3A20000)
    c.mu.hook_add(UC_HOOK_CODE, pb, begin=PB_POST, end=PB_POST)
    c.mu.hook_add(UC_HOOK_CODE, tm, begin=APPTIMER, end=APPTIMER)
    c.exit_calls = []
    def other(uc, addr, *_):                  # the exit's call into another model (0x533BD834, before CIM's stop): recorded, returns
        c.exit_calls.append(addr); c._ret(0)
    c.mu.hook_add(UC_HOOK_CODE, other, begin=0x533BD834, end=0x533BD834)
    for g in (CIM_G, MOD_G, PB_G, 0x5508307C, 0x55084D7C, 0x550874FC, 0x550873D4): c.w32(g, 1)
    return c


def ready(c, on, rtime, screen=0x08000000):
    """frame 4's QUICK_VIEW_READY with CIM+0x27 = on; returns (CIM+0x24 after it, events posted by the decision, playback posts)"""
    c.wb(CIM, bytes(0x40)); c.w8(CIM + 0x27, on); c.w32(REVIEW_T, rtime & 0xFFFFFFFF); c.w32(sim.APP_Q, screen)
    c.wb(CRM, bytes(0x1000)); c.app_posts.clear(); c.pb.clear()
    c.call(0x533EB434, CIM)
    r24 = c.r8(CIM + 0x24)
    ev1 = [p['args'][1] for p in c.app_posts]; c.app_posts.clear()
    c.call(0x533A30A0, CRM)
    ev2 = [p['args'][1] for p in c.app_posts]
    if 0xC8 in ev2: c.call(0x5325D934, 0)
    return r24, ev1, ev2, list(c.pb), c.r8(CIM + 0x27), c.r8(CIM + 0x24)


def timer(c, sub, rtime):
    c.w32(REVIEW_T, rtime & 0xFFFFFFFF); c.wb(QV, bytes(0x200)); c.w8(QV + 0x170, sub)
    c.app_posts.clear(); c.timers.clear()
    c.call(0x531EB780, QV)
    started, t = c.r32(QV + 0x17C), list(c.timers)
    at_start = [(p['args'][1], c.r32(p['args'][2]) if p['args'][2] else 0) for p in c.app_posts]; c.app_posts.clear()
    exp = None
    if started:
        c.call(0x531EB534, QV, started)
        exp = [(p['args'][1], c.r32(p['args'][2]), c.r32(p['args'][2] + 4)) for p in c.app_posts]
    return t, at_start, exp, c.r8(QV + 0x184), c.r32(QV + 0x17C)


for label, rtos in (('base build', BASE_RTOS), ('test build', TEST_RTOS)):
    c = cam(rtos)
    for rt, rtx in ((0, 'off'), (500, '0.5 s'), (-1, 'hold')):
        r24, e1, e2, pb, on, rd = ready(c, 0, rt)
        check(f'{label}: +0x27 = 0 (mf13..mf17 at the group\'s end), review time {rtx}: READY leaves +0x24 at 0, the decision posts 0xC8, its handler posts nothing to'
              f' the playback task (the picture stays)', r24 == 0 and e1 == [0x159] and e2 == [0xC8] and pb == [], str((r24, e1, e2, pb)))
    r24, e1, e2, pb, on, rd = ready(c, 1, 500)
    check(f'{label}: +0x27 = 1 (REVIEW_ARM), review time 0.5 s: +0x24 set, the decision posts 0x94 (the review screen), nothing stopped yet',
          r24 == 1 and e2 == [0x94] and pb == [] and on == 1, str((r24, e2, pb)))
    r24, e1, e2, pb, on, rd = ready(c, 1, 2000)
    check(f'{label}: +0x27 = 1, review time 2 s: 0x94', e2 == [0x94] and pb == [])
    r24, e1, e2, pb, on, rd = ready(c, 1, -1)
    check(f'{label}: +0x27 = 1, review "hold": 0x94 (the review stays until a key, as stock)', e2 == [0x94] and pb == [])
    r24, e1, e2, pb, on, rd = ready(c, 1, 0)
    check(f'{label}: +0x27 = 1, review off: 0xC8 and its handler stops the direct / quick view (0x4441100C), +0x27 / +0x24 cleared',
          e2 == [0xC8] and pb == [STOP] and on == 0 and rd == 0, str((e2, pb, on, rd)))
    r24, e1, e2, pb, on, rd = ready(c, 1, 500, screen=0x0800000D)
    check(f'{label}: +0x27 = 1 but another screen up (the review screen already): 0xC8 and the stop', e2 == [0xC8] and pb == [STOP], str((e2, pb)))
    for rt, want in ((500, 'timer'), (2000, 'timer'), (0, 'now'), (-1, 'none')):
        t, st, exp, f184, left = timer(c, 0, rt)
        if want == 'timer':
            ok = t == [(rt, QV + 0x158)] and not st and exp == [(0x178, 0x08000000, 0x10000000)] and f184 == 1 and left == 0
        elif want == 'now':
            ok = not t and st == [(0x178, 0x08000000)] and f184 == 1
        else:
            ok = not t and not st and exp is None and f184 == 0
        check(f'{label}: review screen (sub-screen 0), review time {rt} ms: ' + {'timer': f'AppTimer started with {rt} ms; at its expiry the screen change 0x178 to the shooting screen 0x08000000 (flag +0x184)',
              'now': 'no timer, the shooting screen at once', 'none': 'no timer, no screen change (hold)'}[want], ok, str((t, st, exp, f184, left)))
    t, st, exp, f184, left = timer(c, 5, 500)
    check(f'{label}: a multi-exposure review (sub-screen 5): the timer runs but its expiry changes no screen', t and exp == [] and f184 == 0, str((t, exp)))
    # the review screen's exit: CIM's review stop at 0x531EB870
    for on, want in ((1, [STOP]), (0, [])):
        c.wb(CIM, bytes(0x40)); c.w8(CIM + 0x27, on); c.w8(CIM + 0x24, on); c.wb(QV, bytes(0x200)); c.w8(QV + 0x184, 1); c.pb.clear()   # (+0x184: set by the timer's expiry)
        c.call(0x531EB828, QV)
        check(f'{label}: the review screen\'s exit with +0x27 = {on}: ' + ('the playback stop posted, +0x27 / +0x24 cleared (the picture goes, live view shows)' if on else 'nothing posted (mf17: no stop)'),
              c.pb == want and c.r8(CIM + 0x27) == 0, str((c.pb, c.r8(CIM + 0x27))))
c0, c1 = cam(BASE_RTOS), cam(TEST_RTOS)
same = all(c0.rb(a, n) == c1.rb(a, n) for a, n in ((0x533EB434, 0x40), (0x533A2FC4, 0x150), (0x5325D934, 0x90), (0x531EB534, 0x90), (0x531EB780, 0x80), (0x531EB828, 0x120), (0x533EB020, 0x180)))
check('the stock review code is the same in both builds (READY, decision, 0xC8 handler, timer start / expiry, exit, StopReview)', same)
print('ALL PASS' if not fails else f'{fails} FAILED')
sys.exit(1 if fails else 0)
