# SPDX-License-Identifier: GPL-2.0-only
"""Read the multi-frame NR / night mode log files: C:\\MFxxxxxx.BIN (struct mf_log in mfmod.c, versions 1 to 23; versions 12 to 22
with the tap block at their end) and the per-press files C:\\MPxxxxxx.BIN (mf17, struct press_log; version 2 from mf18, 3 from mf19).
usage: read_mf.py FILE...   (prints one summary per file)"""
import struct, sys

RESULTS = ['none', 'merged', 'short group', 'exposure differs', 'memory', 'time limit', 'merge error', 'geometry', 'burst broken (drive/format)',
           'switch off', 'ISO out of table', 'black/white levels', 'below the gate', 'alternate changed or moved (canary)', 'power off during the merge']
FRAME = ['tick', 'gap_us', 'copy_us', 'recipe', 'bayer', 'index', 'seqtype', 'tv', 'av', 'sv', 'tv_us', 'img1_total', 'img1_largest', 'img2_total', 'img2_largest']
WORDS = 298


def f32(u): return struct.unpack('<f', struct.pack('<I', u))[0]


def parse1(b):
    if len(b) < 4 * WORDS: raise ValueError('short log')
    w = struct.unpack_from(f'<{WORDS}I', b)
    if w[0] != 0x474C464D or w[1] != 1 or w[2] != 4 * WORDS: raise ValueError('not a version 1 MF log')
    g = dict(result=w[3], result_text=RESULTS[w[3]] if w[3] < len(RESULTS) else '?', frames=w[4], tail_before=w[5], width=w[6], height=w[7],
             line=w[8], bayer_size=w[9], bayer_raw=w[10], cfa=w[11], bits=w[12], black=list(w[13:17]), white=w[17], black_used=w[18],
             sv_index=w[19], nshift=w[20], ntab=list(w[21:25]), need=w[25], block=w[26], merge_us=w[27], stop_at=w[28], write_us=w[29],
             written=w[30], nr_before=w[31], nr_after=w[32], align_us=list(w[33:40]), k_q12=list(w[40:47]), used=list(w[47:54]),
             gy=[x - (1 << 32) if x >> 31 else x for x in w[54:61]], gx=[x - (1 << 32) if x >> 31 else x for x in w[61:68]],
             wsum=list(w[68:75]), wcount=w[75], strips=w[76])
    g['ref_sample'] = list(struct.unpack_from('<32H', b, 4 * 77)); g['out_sample'] = list(struct.unpack_from('<32H', b, 4 * 93))
    g['f'] = [dict(zip(FRAME, w[109 + 15 * i:124 + 15 * i])) for i in range(8)]
    for f in g['f']:
        for k in ('tv', 'av', 'sv'): f[k + '_f'] = f32(f[k])
    g['h1_seq'] = w[229]
    g['h1'] = [dict(zip(('tick', 'count', 'stock', 'answer'), w[230 + 4 * i:234 + 4 * i])) for i in range(16)]
    g['files'], g['mode_before'] = w[294], w[295]
    g['mean_weight'] = [round(s / (64 * g['wcount']), 3) if g['wcount'] else 0 for s in g['wsum'][:3]]
    return g


def summary1(g):
    out = [f"{g['result_text']}: {g['frames']} frames {g['width']}x{g['height']} black {g['black']} white {g['white']} Sv index {g['sv_index']}"]
    for i, f in enumerate(g['f'][:max(1, min(g['frames'], 8))]):
        out.append(f"  frame {i + 1}: gap {f['gap_us'] / 1000:.0f} ms copy {f['copy_us'] / 1000:.0f} ms index {f['index']} Tv {f['tv_f']:.3f} Av {f['av_f']:.3f} Sv {f['sv_f']:.3f}"
                   f" IMAGE1 {f['img1_total'] >> 20}/{f['img1_largest'] >> 20} MB IMAGE2 {f['img2_total'] >> 20}/{f['img2_largest'] >> 20} MB")
    out.append(f"  need {g['need'] >> 20} MB at {g['block']:#x}; merge {g['merge_us'] / 1000:.0f} ms (align done at {[x // 1000 for x in g['align_us'][:3]]} ms), written {g['written']}, NR byte {g['nr_before']}->{g['nr_after']}")
    out.append(f"  k {[round(k / 4096, 4) for k in g['k_q12'][:3]]} used {g['used'][:3]} offsets {list(zip(g['gy'][:3], g['gx'][:3]))} mean weight {g['mean_weight']}")
    return '\n'.join(out)


FRAME2 = ['tick', 'gap_us', 'copy_us', 'recipe', 'bayer', 'index', 'seqtype', 'tv', 'av', 'sv', 'tv_us', 'white_si', 'chunk', 'flags',
          'img1_total', 'img1_largest', 'img2_total', 'img2_largest', 'img2_after']
FLAGS = ['copied', 'no memory', 'geometry', 'used', 'exposure differs']
FLAGS11 = ['held', 'no memory', 'geometry', 'used', 'exposure differs', 'changed (canary)', 'moved by stock', 'no slot']   # version 11
WORDS2 = 306
# version 7, struct mf_log after iso_gate (mfmod.c): the merge on three cores
# version 8 probes (struct mf_log in mfmod.c): (name, number of words)
V8 = [('core_start', 1), ('core_checks', 4), ('w_core', 4), ('jobs_p1', 3), ('jobs_p2', 3), ('job_busy_us', 3), ('job_max_us', 3), ('w_stack', 2),
      ('w_wake_sum_us', 2), ('w_wake_max_us', 2), ('m_wait_us', 1), ('rounds', 1), ('t_ref_us', 1), ('t_written_us', 1), ('prev_log_us', 1),
      ('bw_bytes', 1), ('bw_us', 9), ('wakes', 1), ('ui', 6), ('h1_iso', 16), ('pools_end', 4), ('progress_end', 1)]
V8_LEN = sum(n for _, n in V8)
# version 9: NR byte per frame (+1, 0 = not set), the memory gate
V9 = [('nr_frame', 4), ('mem_gate_bytes', 1), ('mem_gated', 1), ('mem_skipped', 1), ('mem_total_last', 1)]
V9_LEN = sum(n for _, n in V9)
# version 10: live view off during the merge (A/B), the UI task's view
V10 = [('ab_letter', 1), ('ab_group', 1), ('lv_skips', 1), ('lv_net', 1), ('lv_post_ret', 1), ('lv_defer_us', 1), ('lv_prev_ui', 1), ('ui_calls', 1),
       ('ui_nsamples', 1), ('ui_samples', 24)]
V10_LEN = sum(n for _, n in V10)
# version 11 (mf13): hold instead of copy, merge block layout, recipe dumps, thread timing, live view after the previous group
HOLD_WORDS = ['raw', 'px', 'reg_tick', 'canary', 'st_merge', 'final', 'site', 'dup', 'canary_before', 'canary_after', 'caller', 'hdr']
REC_IDS = [1, 2, 3, 4, 6, 7, 9, 24]
V11 = [('hold', 36), ('hold_rule', 1), ('hold_frees', 1), ('merge_layout', 1), ('out_room', 1), ('rec_n', 2), ('rec', 252),
       ('job_min_p2_us', 3), ('busy_p_us', 6), ('m_wait_p_us', 2), ('w_idle_us', 2), ('rounds_p', 2), ('t_p2_us', 1),
       ('prev_lv_start_ret', 1), ('prev_lv_start_us', 1), ('prev_app_ret', 1), ('prev_app_us', 1), ('prev_post_n', 1), ('prev_post', 60)]
V11_LEN = sum(n for _, n in V11)
# version 12 (mf14): the merge memory in parts
V12 = [('parts_tries', 1), ('parts_threads', 1), ('out_split', 1), ('part_size', 6), ('part_addr', 6), ('part_pool', 16), ('rv_ret', 1), ('rv_us', 1),
       ('hc_src', 1), ('hc_applied', 1), ('w_step', 1), ('w_a', 2), ('w_b', 2), ('nshift_w', 1), ('ntab_w', 4), ('hc', 4 * 19)]
V12_LEN = sum(n for _, n in V12)
# version 13 (mf15): the merge in stages (MF_ST_* of mf_core.h), before the tap block
STAGES = ['pyramids', 'levels 3-2', 'level 1', 'level 0', 'gain', 'merge setup', 'row pipeline', 'after rows']
V13 = [('st_us', 8), ('st_tail_us', 8), ('st_rounds', 8), ('spec', 1)]
V13_LEN = sum(n for _, n in V13)
# version 14 (mf16): the UI fallback after the previous group, the review-stop switch of the build
V14 = [('prev_fb_ret', 1), ('prev_fb_us', 1), ('review_stop', 1)]
V14_LEN = sum(n for _, n in V14)
# version 15 (mf17, night mode): before the tap block
V15 = [('build_flags', 1), ('ev_gate', 1), ('ev256', 4), ('gate', 4), ('shut', 1), ('lv_e3', 1), ('fe_plans', 1), ('arm_h2', 1), ('h2_end', 1),
       ('hide', 4), ('nr_prep', 1), ('nr_new', 1), ('sv_nom', 1), ('sv_eq', 1), ('idx_eq', 1), ('nrset_nom', 1), ('eq_mod', 8), ('wb1', 2),
       ('wb4', 4), ('wb_state', 1), ('tone_on', 1), ('tone_ret', 1), ('tone_us', 1), ('tone_g_q8', 1), ('tone_d_q8', 1), ('tone_n_q8', 1),
       ('tone_lift_q8', 1), ('tone_changed', 1), ('boost8', 1), ('tone_full_q8', 1), ('tone_cap_q8', 1), ('tone_q16', 5), ('tone_clip', 3),
       ('tone_wb', 4), ('tone_scale_q16', 1), ('tone_iso', 1), ('tone_t', 3), ('press_files', 1), ('nb_flags', 1), ('tvmin', 1), ('isoup', 1),
       ('user_tvmin', 1), ('user_isoup', 1), ('nd_switches', 1), ('nd_ev', 1), ('ui_ticks', 1)]
V15_LEN = sum(n for _, n in V15)
V15_SIGNED = {'ev256', 'idx_eq', 'tone_g_q8', 'tone_d_q8', 'tone_n_q8', 'tone_lift_q8', 'boost8', 'tone_full_q8', 'tone_cap_q8', 'tone_q16', 'nd_ev'}
BF = ['shutdown stop', 'frames 1-3 hidden', 'press log', 'NR Auto at equivalent ISO', 'frame 1 white balance', 'night drive', 'auto-ISO limits', 'brightening',
      'review armed after the merge', 'brightening capped', 'event log', 'AsShotNeutral of frame 1', 'review watch',
      'whole white balance of frame 1', 'brightening d capped', 'tone menu byte', 'OSD shown during the merge', 'review end after the merge']
# version 16 (mf18): the review arm of a merged group and the UI task's watch after it (struct rv_watch), the brightening's cap, the
# shutter hook's word
RV = [('ret', 1), ('arm_us', 1), ('review_ms', 1), ('calls', 1), ('gap_us', 1), ('gap_at_us', 1), ('t24_us', 1), ('t27off_us', 1),
      ('tscreen_us', 1), ('screen', 1), ('tback_us', 1), ('tlv_us', 1), ('last', 1), ('end_us', 1), ('on', 1), ('tick_last', 1)]
RV_LEN = sum(n for _, n in RV)
V16 = [('prev_rv', RV_LEN), ('rv', RV_LEN), ('rv_win_us', 1), ('tone_nmax_q16', 1), ('shutter_word', 1)]
V16_LEN = sum(n for _, n in V16)
# the 27 MHz tick counts down and reloads every 2^26 us (1 811 939 328 ticks); a plain 32-bit difference across a reload is
# 2^32 - 1 811 939 328 = 2 483 027 968 ticks (91 964 ms) too large (the indicator's "longest gap" of 92 s in the mf17 logs)
TICK_RELOAD_EXCESS = (1 << 32) - 1811939328


# version 17 (mf19): module marks, AsShotNeutral, the event / playback rings (struct ev_log)
EV_N, EV_W, PB_NN = 128, 7, 32
EVL_LEN = 5 + EV_N * EV_W + PB_NN * 4
V17 = [('bem', 16), ('asn1', 8), ('asn4', 16), ('asn_state', 1), ('evl', EVL_LEN)]
V17_LEN = sum(n for _, n in V17)
# version 18 (final build): the white balance set of frame 1 and the merged frame (before / after), the learned AWB's diagnostic
# record at both Pipe1s, the d cap, the menu byte
WBSET = ['gains R|G1', 'gains G2|B', 'hr R|G1', 'hr G2|B', '38AE8', '38AEC', '38B08', 'cte R|G', 'cte G|B', 'auto R|G', 'auto G|B', 'lsd 34968',
         'asn R num', 'asn R den', 'asn G num', 'asn G den', 'asn - num', 'asn - den', 'asn B num', 'asn B den']
V18 = [('wbv2_state', 1), ('wbs1', 20), ('wbs4', 40), ('awbd1', 16), ('awbd4', 16), ('tone_dmax_q16', 1), ('tone_menu', 1)]
V18_LEN = sum(n for _, n in V18)
# version 19 (mf21): the display watch (struct dv_watch) of the previous group and of this one; press log version 4 has the last one
DV_SAMPLES = 20
DV = [('on', 1), ('result', 1), ('osd_ticks', 1), ('osd_n', 1), ('osd_first_us', 1), ('osd_last_us', 1), ('osd_skip', 1), ('osd_full_n', 1),
      ('held', 1), ('held_us', 1), ('at_end', 1), ('lcd_end', 1), ('lcd2_end', 1), ('re_ret', 1), ('re_t159_us', 1), ('re_post_us', 1),
      ('re_review_ms', 1), ('re_be', 3), ('re_be_us', 1), ('n', 1), ('smp', 5 * DV_SAMPLES)]
DV_LEN = sum(n for _, n in DV)
V19 = [('prev_dv', DV_LEN), ('dv', DV_LEN)]
V19_LEN = sum(n for _, n in V19)
# version 20 (mf22): the display watch grows by the Display Time words and the post's check (struct dv_watch, 128 words); the
# REVIEW_END fields mean: the merged frame on screen (was the READY), the wait, BE / CIM words recorded (no restore), +0xAA back to 0;
# the samples' fourth word carries LVC +0x58 and the shooting screen; press log version 5 has it
DV20 = DV[:14] + [('re_shown_us', 1), ('re_post_us', 1), ('re_review_ms', 1), ('re_be', 3), ('re_gone_us', 1), ('rvs_flags', 1), ('rvs_user_ms', 1),
                  ('rvs_set_ms', 1), ('rvs_rt_ms', 1), ('re_chk_lcd', 1), ('re_chk_lv', 1), ('n', 1), ('smp', 5 * DV_SAMPLES)]
DV20_LEN = sum(n for _, n in DV20)
V20 = [('prev_dv', DV20_LEN), ('dv', DV20_LEN)]
V20_LEN = sum(n for _, n in V20)
# version 21 (mf23): PROC_SCREEN (LiveViewController +0x4E5 taken during the merge) and the merge samples; the log's wait (LOG_DEFER)
MSMP_N = 32
DV21 = DV20 + [('ps_n', 1), ('ps_first_us', 1), ('ps_back_us', 1), ('ps_back', 1), ('ps_skip', 1), ('ps_ctrl', 1), ('mn', 1), ('msmp', 3 * MSMP_N)]
DV21_LEN = sum(n for _, n in DV21)
V21_LEN = 2 * DV21_LEN + 2
# version 22 (mf24, the final build's switches): KEEP_LAST_ONLY per frame 1-3 (this group's as far as known, the previous group's),
# keep_flags = KEEP_LAST_ONLY | PROBES << 1 | PROGRESS_BAR << 2.  The final build (PROBES 0) writes no file: its records reach only the
# emulator (sim.py's sink); a camera log of version 22 comes from the recording build (PROBES 1).
V22_LEN = V21_LEN + 7
KEEP = {0: '-', 1: 'waiting for its store', 2: 'stored (its store came before the result)', 3: 'no file (dropped)', 4: 'stored (power key / shutdown)',
        5: 'stored (too late)', 6: 'stored (the store\'s other path)', 7: 'stored (not used in the merge)', 8: 'gone (recipe reused before its store)',
        9: 'stored (group not merged)', 10: 'no file (frame 1, decided at its store: frame 2 already in the group)',
        11: 'stored (frame 1, its store came while it was the only frame)'}
def keep_text(ws): return [f"{KEEP.get(w & 0xFF, w & 0xFF)}{' at ' + str(w >> 8) + ' ms' if w >> 8 else ''}" for w in ws]
PS_BACK = {0: 'not taken / still ours', 1: 'merge end, put back', 2: 'a release', 3: 'the power key', 4: 'another screen', 5: 'a picture on screen',
           6: 'fallback (outside the merge)'}
LOG_WAIT = {0: 'no wait', 1: "the post's check done", 2: 'review end over without a post', 3: '3 s after the end', 4: 'a release',
            5: 'the power key', 6: 'off', 7: 'no semaphore'}
HELD = {0: 'none', 1: 'ours stands', 2: 'the stock set it again', 3: 'put back (guard, picture up)', 4: 'put back at a release',
        5: 'guard: no picture, left 0', 6: 'release: left to the stock'}
RE_RET = {0: 'not reached', 0xEEE0: 'off', 0xEEE1: 'a group / release started', 0xEEE2: 'a key', 0xEEE3: '+0x27 set', 0xEEE4: 'no picture',
          0xEEE5: 'not the shooting screen', 0xEEE6: 'shutting down', 0xEEE7: 'review hold', 0xEEE8: 'no READY in time', 0xEEE9: 'not merged',
          0xEEEF: 'CIM not constructed'}
RE_RET20 = {**RE_RET, 0xEEE4: 'the picture went before the time', 0xEEE8: 'merged frame not shown in time'}


def ms_text(v): return {0xFFFFFFFF: 'Hold', 0xFFFFFFFE: 'none kept', 0: 'Off'}.get(v, f'{v} ms')


def dv_of(x, v20=False, v21=False):
    d = {'v20': v20, 'v21': v21}; o = 0
    for name, n in (DV21 if v21 else DV20 if v20 else DV):
        d[name] = list(x[o:o + n]) if n > 1 else x[o]; o += n
    d['smp'] = [d['smp'][5 * i:5 * i + 5] for i in range(min(DV_SAMPLES, d['n']))]
    if v21: d['msmp'] = [d['msmp'][3 * i:3 * i + 3] for i in range(min(MSMP_N, d['mn']))]
    return d


def dv_text(d):
    def cim(w): return '-' if w == 0xFFFFFFFF else f"24 {w & 255} 25 {w >> 8 & 255} 26 {w >> 16 & 255} 27 {w >> 24}"
    def lcd(w): return '-' if w == 0xFFFFFFFF else f"layers {w & 255}{w >> 8 & 255}{w >> 16 & 255} dd0 {w >> 24}"
    def be(w): return '-' if w == 0xFFFFFFFF else f"CBC {w & 255} CBD {w >> 8 & 255} 2DE {w >> 16 & 255}"
    skip = ' '.join(t for b, t in ((1, '+0x27 set'), (2, 'other screen'), (4, 'no CIM'), (8, 'LVC unknown / shutdown'), (16, '+0x25 already 0')) if d['osd_skip'] & b)
    rr = d['re_ret']
    out = [f"merge: {d['osd_ticks']} UI loops, panel {d['osd_full_n']}, +0x25 written 0 {d['osd_n']} times (first {d['osd_first_us'] / 1000:.0f} ms,"
           f" last {d['osd_last_us'] / 1000:.0f} ms){', skipped: ' + skip if skip else ''}; ours: {HELD.get(d['held'], d['held'])}"
           f" at {d['held_us'] / 1000:.0f} ms; after the merge: CIM {cim(d['at_end'])}, LCD {lcd(d['lcd_end'])}",
           f"review end: {'posted (return %#x)' % (rr >> 8) if rr & 0xFF == 1 and rr < 0x10000 else RE_RET.get(rr, hex(rr))}; READY at {d.get('re_t159_us', 0) / 1000:.0f} ms,"
           f" post at {d['re_post_us'] / 1000:.0f} ms, review {d['re_review_ms']} ms; BE before {be(d['re_be'][0])}, taken {be(d['re_be'][1])}"
           f" at {d.get('re_be_us', 0) / 1000:.0f} ms, after {be(d['re_be'][2])}"]
    if d.get('v20'):
        f = d['rvs_flags']; lv = d['re_chk_lv']
        out[1] = (f"review end: {'posted (return %#x)' % (rr >> 8) if rr & 0xFF == 1 and rr < 0x10000 else RE_RET20.get(rr, hex(rr))}; merged frame on screen"
                  f" (+0xAA 1) at {d['re_shown_us'] / 1000:.0f} ms, post at {d['re_post_us'] / 1000:.0f} ms, wait {ms_text(d['re_review_ms'])};"
                  + (f" +0xAA back to 0 at {d['re_gone_us'] / 1000:.0f} ms" if d['re_gone_us'] else " +0xAA not seen 0 after the post"))
        if rr & 0xFF == 1 and rr < 0x10000:
            out[1] += (f"; {RE_CHECK_MS} ms after the post: LCD {lcd(d['re_chk_lcd'])}, CIM {cim(d['re_be'][2])}, LVC58 {lv & 255}, shooting {lv >> 8 & 255},"
                       f" +0x27 {lv >> 16 & 255}; BE before {be(d['re_be'][0])} then {be(d['re_be'][1])} (recorded only)")
        out.append(f"Display Time (Instant Review): flags {f:#x} ({'ours (Off) in the camera, the user' + chr(39) + 's ' + ms_text(d['rvs_user_ms']) + ' kept' if f & 4 else 'not ours'});"
                   f" camera's setting CUR+0x914 {ms_text(d['rvs_set_ms'])}, review reads CUR+0x1458 {ms_text(d['rvs_rt_ms'])}")
        out += [f"  {s[0] / 1000:6.0f} ms  CIM {cim(s[1])}  LCD {lcd(s[2])} b1/b9 {s[3] & 0xFFFF:#x} LVC58 {s[3] >> 16 & 255} shooting {s[3] >> 24}  BE {be(s[4])}" for s in d['smp']]
        if d.get('v21'):
            sk = ' '.join(t for b, t in ((1, '+0x27'), (2, 'screen'), (4, 'no CIM'), (8, 'LVC / shutdown'), (16, '+0x25'), (32, '+0xAA'), (64, 'controller unknown'),
                                         (128, 'front end busy'), (256, '+0x4E5 already 0')) if d['ps_skip'] & b)
            pb = d['ps_back']
            out.append(f"processing screen (mf23): +0x4E5 written 0 {d['ps_n']} times (first {d['ps_first_us'] / 1000:.0f} ms into the merge), given back:"
                       f" {PS_BACK.get(pb & 0xF, pb)}{' (the stock had changed it: left)' if pb & 0x10 else ''} at {d['ps_back_us'] / 1000:.0f} ms;"
                       f" controller {d['ps_ctrl']:#x}{'; not taken because: ' + sk if sk else ''}")
            out += [f"  merge {m[0] / 1000:6.0f} ms  LCD {lcd(m[1])}  +0x4E5 {m[2] & 15} ours {m[2] >> 4 & 15} CRM+0xB {m[2] >> 8 & 255} CIM25 {m[2] >> 16 & 255} 27 {m[2] >> 24}"
                    for m in d['msmp']]
        return out
    out += [f"  {s[0] / 1000:6.0f} ms  CIM {cim(s[1])}  LCD {lcd(s[2])} b1/b9 {s[3]:#x}  BE {be(s[4])}" for s in d['smp']]
    return out
RE_CHECK_MS = 2000
EV_NAMES = {0x14C: 'release (CIM +0x27 = 1)', 0x14F: 'capture start', 0x159: 'CIM: QUICK_VIEW_READY seen', 0x94: 'review screen requested',
            0xC8: 'no review (0xC8)', 0x36: 'key action (cancels the review)', 0x178: 'screen change', 0x17D: 'callback (timer)',
            0xF9: 'review: F9', 0xFA: 'review timer: FA', 0x93: 'CaptureReady 0x93', 0x14D: 'CaptureReady 0x14D', 0xBC: 'CaptureReady 0xBC'}
PB_NAMES = {0x4441100C: 'STOP direct + quick view', 0x4441100A: 'QUICK_VIEW'}
G_FULL_MAX = 26.5754                       # night_tone AGC: 8 rounds of at most x10 (libcamera's limit): log2(10^8)


def ev_of(x):
    e = dict(n=x[0], skip=x[1], crm=x[2], pb_n=x[3], tick=x[4])
    ring = [x[5 + EV_W * i:5 + EV_W * i + EV_W] for i in range(EV_N)]
    k = min(e['n'], EV_N)
    order = [(e['n'] - k + j) % EV_N for j in range(k)]
    e['ev'] = [dict(zip(('tick', 'evs', 'a', 'b', 'w4', 'w5', 'w6'), ring[i])) for i in order]
    o = 5 + EV_W * EV_N
    pr = [x[o + 4 * i:o + 4 * i + 4] for i in range(PB_NN)]
    k = min(e['pb_n'], PB_NN)
    e['pb'] = [dict(zip(('tick', 'cmd', 'r2', 'r3'), pr[(e['pb_n'] - k + j) % PB_NN])) for j in range(k)]
    return e


def tdiff(a, b):
    """microseconds from tick a to the later tick b (27 MHz, counting down, reload every 2^26 us)"""
    d = (a - b) & 0xFFFFFFFF
    if d >= 0xC0000000: return (d - (1 << 32)) / 27.0          # b before a (a negative time)
    if d >= TICK_RELOAD_EXCESS: d -= TICK_RELOAD_EXCESS
    return d / 27.0


def timeline(e, ref_tick, label):
    """one line per event / playback post, in order, ms after ref_tick"""
    rows = []
    for v in e['ev']:
        ev, scr = v['evs'] & 0xFFFF, v['evs'] >> 16
        w4, w5, w6 = v['w4'], v['w5'], v['w6']
        b = lambda w, i: w >> (8 * i) & 0xFF
        rows.append((tdiff(ref_tick, v['tick']) if ref_tick else 0, f"ev {ev:#05x} {EV_NAMES.get(ev, ''):<34} a {v['a']:#x} b {v['b']:#x} | screen {scr:#06x}"
                     f" CIM24 {b(w4, 0) & 15} 25 {b(w4, 0) >> 4} 27 {b(w4, 1)} LVC58 {b(w4, 2)} root vis {b(w4, 3)} | CRM 8 {b(w5, 0)} 9 {b(w5, 1)} B {b(w5, 2)} EE0 {b(w5, 3)}"
                     f" | App LV {b(w6, 0)}/{b(w6, 1)}/{b(w6, 2)} ctrl14E {b(w6, 3)}"))
    for v in e['pb']:
        rows.append((tdiff(ref_tick, v['tick']) if ref_tick else 0, f"playback post {v['cmd']:#010x} {PB_NAMES.get(v['cmd'], '')} r2 {v['r2']:#x} r3 {v['r3']:#x}"))
    rows.sort(key=lambda r: r[0])
    out = [f"  {label}: {e['n']} events ({min(e['n'], EV_N)} kept, {max(0, e['n'] - EV_N)} older ones lost), {e['skip']} not kept (log <= 19: 0x17D without a callback; 20: every 0x17D / 0x181 timer callback),"
           f" {e['pb_n']} playback posts ({min(e['pb_n'], PB_NN)} kept); CaptureReadyModel {e['crm']:#x}"]
    out += [f"    {t / 1000:9.1f} ms  {txt}" for t, txt in rows]
    return out


def rv_of(x):
    return dict(zip([n for n, _ in RV], x))
# ---- version 12, tap block (mf14 change 3, H2 at 0x5367E6AC): the last words of the log; read from its end, so other version-12
# fields added before it do not move it.  h2 ring entries: tick, SEQ+0x104, flags (H2_FLAGS bits), answer, age of H1's continue (us)
V12_TAP = [('h2_limit_us', 1), ('h2_seq', 1), ('h2_cont', 1), ('h2', 80)]
V12_TAP_LEN = sum(n for _, n in V12_TAP)
H2_FLAGS = ['F1', 'F8', 'F3', '11A', '113', '11E', '122', 'continuous', 'count 1-3', "H1's continue", '< limit', 'NO STOP']
# ---- end of the tap block
BUFS = 'Bayer DarkBayer AdjustBayer Jpeg InlineYCbCr ElaNoise CompressRaw WaveDetectIq Work1 Work2 Tiff ResizeNr FringeYCbCr AdvancedNrYCbCr HDRYCbCr ElaBayerDomain Rrs_Bayer Rrs_Work Rrs_Ycc Rrs_Map TransmissiveYCbCr DigitalFilter MultiYCbCr CaptureBuffer_YccCnr_Work'.split()
MT_WORDS = ['threads', 'fail_step', 'fail_code', 'setup_us', 'phase1_us', 'phase2_us', 'jobs0', 'jobs1', 'jobs2', 'busy1', 'busy2',
            'actlr1', 'actlr2', 'pri', 'stack']
MT_FAIL = {1: 'tk_cre_sem (done)', 2: 'tk_cre_sem (go)', 4: 'tk_cre_tsk (worker 1)', 5: 'tk_cre_tsk (worker 2)', 6: 'tk_sta_tsk (worker 1)',
           7: 'tk_sta_tsk (worker 2)', 8: 'tk_del_tsk (worker 1)', 9: 'tk_del_tsk (worker 2)', 10: 'tk_sig_sem go (worker 1)', 11: 'tk_sig_sem go (worker 2)',
           12: 'tk_wai_sem done', 13: 'tk_sig_sem quit (worker 1)', 14: 'tk_sig_sem quit (worker 2)', 15: 'tk_wai_sem done (quit)',
           16: 'tk_del_sem done', 17: 'tk_del_sem go (worker 1)', 18: 'tk_del_sem go (worker 2)'}


def parse(b):
    if len(b) >= 4 and struct.unpack_from('<I', b)[0] == 0x474C504D:
        p = parse_press(b); p['kind'] = 'press'; return p
    return parse_log(b)


def parse_log(b):
    """Version 2 (2026-11-21, third test build), 3 (+ 18 words: bench, pmin), 4 (+ 1 more: actlr_before), 5 (+ 1 more: vmax),
    6 (+ 1 more: iso_gate), 7 (+ 15 more: the merge on three cores, MT_WORDS) or version 1."""
    if len(b) >= 8 and struct.unpack_from('<2I', b) == (0x474C464D, 1): return parse1(b)
    if len(b) < 4 * WORDS2: raise ValueError('short log')
    w = struct.unpack_from(f'<{WORDS2}I', b)
    extra = {2: 0, 3: 18, 4: 19, 5: 20, 6: 21, 7: 21 + len(MT_WORDS), 8: 21 + len(MT_WORDS) + V8_LEN, 9: 21 + len(MT_WORDS) + V8_LEN + V9_LEN,
             10: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN, 11: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN,
             12: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V12_TAP_LEN,
             13: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V12_TAP_LEN,
             14: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V12_TAP_LEN,
             15: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V15_LEN + V12_TAP_LEN,
             16: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V15_LEN + V16_LEN + V12_TAP_LEN,
             17: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V15_LEN + V16_LEN + V17_LEN + V12_TAP_LEN,
             18: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V15_LEN + V16_LEN + V17_LEN + V18_LEN + V12_TAP_LEN,
             19: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V15_LEN + V16_LEN + V17_LEN + V18_LEN + V19_LEN + V12_TAP_LEN,
             20: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V15_LEN + V16_LEN + V17_LEN + V18_LEN + V20_LEN + V12_TAP_LEN,
             21: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V15_LEN + V16_LEN + V17_LEN + V18_LEN + V21_LEN + V12_TAP_LEN,
             22: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V15_LEN + V16_LEN + V17_LEN + V18_LEN + V22_LEN + V12_TAP_LEN,
             23: 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V15_LEN + V16_LEN + V17_LEN + V18_LEN + V22_LEN + 1 + 3 * MSMP_N + V12_TAP_LEN}.get(w[1])
    if w[0] != 0x474C464D or extra is None or w[2] != 4 * (WORDS2 + extra) or len(b) < 4 * (WORDS2 + extra): raise ValueError('not a version 2 to 23 MF log')
    sg = lambda xs: [x - (1 << 32) if x >> 31 else x for x in xs]
    g = dict(version=2, result=w[3], result_text=RESULTS[w[3]] if w[3] < len(RESULTS) else '?', frames=w[4], tail_before=w[5], width=w[6], height=w[7],
             line=w[8], bayer_size=w[9], bayer_raw=w[10], cfa=w[11], bits=w[12], black=list(w[13:17]), white=w[17], black_used=w[18],
             iso_step=sg([w[19]])[0], sv_index=sg([w[19]])[0], nshift=w[20], ntab=list(w[21:25]), need=w[25], block=w[26], block_pool=w[27], merge_us=w[28],
             stop_at=w[29], write_us=w[30], written=w[31], nr_before=w[32], nr_after=w[33], n_alt=w[34], pools_merge=list(w[35:39]),
             align_us=list(w[39:46]), k_q12=list(w[46:53]), used=list(w[53:60]), gy=sg(w[60:67]), gx=sg(w[67:74]), wsum=list(w[74:81]),
             wcount=w[81], strips=w[82])
    g['out_px'] = list(struct.unpack_from('<32H', b, 4 * 83))
    g['f'] = []
    for i in range(4):
        o = 99 + 35 * i
        f = dict(zip(FRAME2, w[o:o + 19])); f['px'] = list(struct.unpack_from('<32H', b, 4 * (o + 19)))
        for k in ('tv', 'av', 'sv'): f[k + '_f'] = f32(f[k])
        f['flag_text'] = [n for j, n in enumerate(FLAGS11 if w[1] >= 11 else FLAGS) if f['flags'] >> j & 1]
        g['f'].append(f)
    g['h1_seq'] = w[239]
    g['h1'] = [dict(zip(('tick', 'count', 'stock', 'answer'), w[240 + 4 * i:244 + 4 * i])) for i in range(16)]
    g['files'], g['mode_before'] = w[304], w[305]
    g['mean_weight'] = [round(s / (64 * g['wcount']), 3) if g['wcount'] else 0 for s in g['wsum'][:3]]
    g['log_version'] = w[1]
    if w[1] >= 3:
        x = struct.unpack_from('<18I', b, 4 * WORDS2); g['bench'] = list(x[:12]); g['pmin'] = list(x[12:])
    if w[1] >= 4:
        g['actlr_before'] = struct.unpack_from('<I', b, 4 * (WORDS2 + 18))[0]
    if w[1] >= 5:
        g['vmax'] = struct.unpack_from('<I', b, 4 * (WORDS2 + 19))[0]
    if w[1] >= 6:
        g['iso_gate'] = struct.unpack_from('<I', b, 4 * (WORDS2 + 20))[0]
        x = struct.unpack_from(f'<{len(MT_WORDS)}I', b, 4 * (WORDS2 + 21))
        mt = dict(zip(MT_WORDS, x))
        g['mt'] = dict(threads=mt['threads'], fail_step=mt['fail_step'], fail_code=mt['fail_code'] - (1 << 32) if mt['fail_code'] >> 31 else mt['fail_code'],
                       setup_us=mt['setup_us'], phase1_us=mt['phase1_us'], phase2_us=mt['phase2_us'], jobs=[mt['jobs0'], mt['jobs1'], mt['jobs2']],
                       busy_us=[mt['busy1'], mt['busy2']], actlr=[mt['actlr1'], mt['actlr2']], pri=mt['pri'], stack=mt['stack'])
    if w[1] >= 8:
        x = struct.unpack_from(f'<{V8_LEN}I', b, 4 * (WORDS2 + 21 + len(MT_WORDS))); o = 0; v = {}
        for name, n in V8:
            v[name] = x[o] if n == 1 else list(x[o:o + n]); o += n
        v['w_core'] = [v['w_core'][0:2], v['w_core'][2:4]]
        v['bw_us'] = [v['bw_us'][0:3], v['bw_us'][3:6], v['bw_us'][6:9]]
        u = v.pop('ui'); v['ui'] = dict(draws=u[0], first=u[1], last=u[2], max_gap=u[3], vt_fail=u[4], core=u[5])
        v['h1_iso'] = [dict(iso=(e & 0xFFFF) - (0x10000 if e & 0x8000 else 0), gated=bool(e >> 16 & 1), mem=bool(e >> 17 & 1)) for e in v['h1_iso']]
        g['v8'] = v
    if w[1] >= 9:
        x = struct.unpack_from(f'<{V9_LEN}I', b, 4 * (WORDS2 + 21 + len(MT_WORDS) + V8_LEN)); o = 0; v9 = {}
        for name, n in V9:
            v9[name] = list(x[o:o + n]) if n > 1 else x[o]; o += n
        g['v9'] = v9
    if w[1] >= 10:
        x = struct.unpack_from(f'<{V10_LEN}I', b, 4 * (WORDS2 + 21 + len(MT_WORDS) + V8_LEN + V9_LEN)); o = 0; v10 = {}
        for name, n in V10:
            v10[name] = list(x[o:o + n]) if n > 1 else x[o]; o += n
        sm = v10.pop('ui_samples'); v10['ui_samples'] = [tuple(sm[3 * i:3 * i + 3]) for i in range(min(8, v10['ui_nsamples']))]
        g['v10'] = v10
    if w[1] >= 11:
        x = struct.unpack_from(f'<{V11_LEN}I', b, 4 * (WORDS2 + 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN)); o = 0; v11 = {}
        for name, n in V11:
            v11[name] = list(x[o:o + n]) if n > 1 else x[o]; o += n
        v11['hold'] = [dict(zip(HOLD_WORDS, v11['hold'][12 * i:12 * i + 12])) for i in range(3)]
        rec = v11.pop('rec'); out = []
        for p in range(2):
            rs = []
            for k in range(6):
                r = rec[(p * 6 + k) * 21:(p * 6 + k + 1) * 21]
                if not r[0] and not r[1] and not r[2] and not r[3]: rs.append(None); continue
                rs.append(dict(step=r[0] & 0xFFFF, raw_done=r[0] >> 16 & 0xFF, keep=r[0] >> 24, seqtype=r[1],
                               demand=[BUFS[i] for i in range(24) if r[2] >> (i + 1) & 1] + (['id0'] if r[2] & 1 else []),
                               held_ids=[i for i in range(25) if r[3] >> i & 1], sizes_sum=r[4],
                               bufs={REC_IDS[i]: (r[5 + 2 * i], r[6 + 2 * i]) for i in range(8) if r[5 + 2 * i]}))
            out.append(rs)
        v11['rec'] = out
        v11['busy_p_us'] = [v11['busy_p_us'][0:3], v11['busy_p_us'][3:6]]
        pp = v11.pop('prev_post'); v11['prev_post'] = [tuple(pp[3 * i:3 * i + 3]) for i in range(min(20, v11['prev_post_n']))]
        g['v11'] = v11
    if w[1] >= 12:
        x = struct.unpack_from(f'<{V12_LEN}I', b, 4 * (WORDS2 + 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN)); o = 0; v12 = {}
        for name, n in V12:
            v12[name] = list(x[o:o + n]) if n > 1 else x[o]; o += n
        v12['part_size'] = [v12['part_size'][0:3], v12['part_size'][3:6]]
        v12['part_addr'] = [v12['part_addr'][0:3], v12['part_addr'][3:6]]
        pp = v12['part_pool']; v12['part_pool'] = [[tuple(pp[8 * t + 2 * i:8 * t + 2 * i + 2]) for i in range(4)] for t in range(2)]
        v12['w_a'] = v12['w_a'][0] | v12['w_a'][1] << 32; v12['w_b'] = v12['w_b'][0] | v12['w_b'][1] << 32
        hc = v12.pop('hc'); v12['hc'] = [dict(flags=hc[19 * i], si_b80=hc[19 * i + 1:19 * i + 17], si_7e0=hc[19 * i + 17:19 * i + 19]) for i in range(4)]
        g['v12'] = v12
        if w[1] >= 13:
            x = struct.unpack_from(f'<{V13_LEN}I', b, 4 * (WORDS2 + 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN)); o = 0; v13 = {}
            for name, n in V13:
                v13[name] = list(x[o:o + n]) if n > 1 else x[o]; o += n
            g['v13'] = v13
        if w[1] >= 14:
            x = struct.unpack_from(f'<{V14_LEN}I', b, 4 * (WORDS2 + 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN))
            g['v14'] = dict(zip([n for n, _ in V14], x))
        if w[1] >= 15:
            x = struct.unpack_from(f'<{V15_LEN}I', b, 4 * (WORDS2 + 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN)); o = 0; v15 = {}
            for name, n in V15:
                vals = [((y ^ 0x80000000) - 0x80000000) if name in V15_SIGNED else y for y in x[o:o + n]]
                v15[name] = vals if n > 1 else vals[0]; o += n
            g['v15'] = v15
        if w[1] >= 16:
            x = struct.unpack_from(f'<{V16_LEN}I', b, 4 * (WORDS2 + 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V15_LEN))
            g['v16'] = dict(prev_rv=rv_of(x[:RV_LEN]), rv=rv_of(x[RV_LEN:2 * RV_LEN]), rv_win_us=x[2 * RV_LEN], tone_nmax_q16=x[2 * RV_LEN + 1],
                            shutter_word=x[2 * RV_LEN + 2])
        if w[1] >= 17:
            x = struct.unpack_from(f'<{V17_LEN}I', b, 4 * (WORDS2 + 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V15_LEN + V16_LEN))
            g['v17'] = dict(bem=[list(x[4 * k:4 * k + 4]) for k in range(4)], asn1=list(x[16:24]), asn4=[list(x[24:32]), list(x[32:40])], asn_state=x[40],
                            evl=ev_of(x[41:41 + EVL_LEN]))
        if w[1] >= 18:
            x = struct.unpack_from(f'<{V18_LEN}I', b, 4 * (WORDS2 + 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V15_LEN + V16_LEN + V17_LEN))
            g['v18'] = dict(wbv2_state=x[0], wbs1=list(x[1:21]), wbs4=[list(x[21:41]), list(x[41:61])], awbd1=awbd_of(x[61:77]), awbd4=awbd_of(x[77:93]),
                            tone_dmax_q16=x[93], tone_menu=x[94])
        if w[1] >= 19:
            v20, v21 = w[1] >= 20, w[1] >= 21; ln = DV21_LEN if v21 else DV20_LEN if v20 else DV_LEN
            v22, v23 = w[1] >= 22, w[1] >= 23
            x = struct.unpack_from(f'<{2 * ln + (2 if v21 else 0) + (7 if v22 else 0) + (1 + 3 * MSMP_N if v23 else 0)}I', b, 4 * (WORDS2 + 21 + len(MT_WORDS) + V8_LEN + V9_LEN + V10_LEN + V11_LEN + V12_LEN + V13_LEN + V14_LEN + V15_LEN + V16_LEN + V17_LEN + V18_LEN))
            g['v19'] = dict(prev_dv=dv_of(x[:ln], v20, v21), dv=dv_of(x[ln:2 * ln], v20, v21))
            if v21: g['v21'] = dict(log_wait_us=x[2 * ln], log_wait_why=x[2 * ln + 1])
            if v22: g['v22'] = dict(keep=list(x[2 * ln + 2:2 * ln + 5]), prev_keep=list(x[2 * ln + 5:2 * ln + 8]), keep_flags=x[2 * ln + 8])
            if v23:                    # the recording build's live-view counters with each merge sample (handnight.ts PROBES 1)
                o = 2 * ln + 9; n = min(MSMP_N, x[o]); g['v23'] = dict(rd=[tuple(x[o + 1 + 3 * i:o + 4 + 3 * i]) for i in range(n)])
        # ---- tap block (mf14): at the end of the log
        x = struct.unpack_from(f'<{V12_TAP_LEN}I', b, w[2] - 4 * V12_TAP_LEN); o = 0; t = {}
        for name, n in V12_TAP:
            t[name] = list(x[o:o + n]) if n > 1 else x[o]; o += n
        ring = [t['h2'][5 * i:5 * i + 5] for i in range(16)]
        t['ring'] = [dict(zip(('tick', 'count', 'flags', 'answer', 'age_us'), e)) for e in (ring[(t['h2_seq'] + i) % 16] for i in range(16)) if e[0] or e[2]]
        del t['h2']
        g['tap'] = t
        # ---- end of the tap block
    return g


def awbd_of(x):
    """the learned AWB's 64-byte diagnostic record (awb2.c struct awb2_diag); None if not there"""
    if x[0] != 0x31445741: return None
    b = struct.pack('<16I', *x)
    sg = lambda v: v - (1 << 32) if v >> 31 else v
    lv_calls, lv_done = struct.unpack_from('<2H', b, 4)
    return dict(lv_calls=lv_calls, lv_done=lv_done, lv_e30=sg(x[2]), lv_exp=b[12], lv_mode=b[13], cap_exp=b[14], cap_path=b[15],
                lv_mu=[sg(x[4]), sg(x[5])], cap_e30=sg(x[6]), cap_v24=sg(x[7]), cap_z=[sg(x[8]), sg(x[9])], cap_r=[x[10], x[11]],
                cap_n=x[12] & 0xFFFF, cap_valid=x[12] >> 16, cap_few=x[13] & 0xFFFF, cap_bright=x[13] >> 16, cap_gr=x[14] & 0xFFFF, cap_gb=x[14] >> 16,
                lv_valid=x[15] & 0xFFFF, cap_mode=x[15] >> 16 & 0xFF, caps=x[15] >> 24)


def wbset_text(o):
    g = [o[0] & 0xFFFF, o[0] >> 16, o[1] & 0xFFFF, o[1] >> 16]; h = [o[2] & 0xFFFF, o[2] >> 16, o[3] & 0xFFFF, o[3] >> 16]
    asn = [o[12 + 2 * k] / o[13 + 2 * k] if o[13 + 2 * k] else 0 for k in (0, 1, 3)]
    return (f"gains {g} headroom {h} (x{o[6]:#x}) 38AE8 {o[4]:#x} AEC {o[5]:#x} cte stash {[o[7] & 0xFFFF, o[8] >> 16]} auto stash {[o[9] & 0xFFFF, o[10] >> 16]}"
            f" lsd {o[11]:#x} asn {[round(a, 4) for a in asn]}")


PATHS = {1: 'live view state', 2: 'own estimate', 3: 'nothing written', 4: 'not an Auto mode', 5: 'flash'}


def summary_v18(v):
    ws = v['wbv2_state']
    st = {0: 'not reached', 1: "written (frame 1's)", 2: "frame 1's not taken", 4: 'equal already', 5: 'WB_FIRST_V2 off'}.get(ws & 0xFF, '?')
    if ws >> 8:                          # log 20 (mf22): which sections the write changed
        st += '; sections changed: ' + (', '.join(t for b, t in ((1, 'gains / headroom gains / stashes (+0x2EBE8..)'), (2, 'light source (+0x34968..)'),
                                                           (4, 'AsShotNeutral (+0x38BA4..)'), (8, 'headroom words (+0x38AE8 / AEC / B08)')) if ws >> 8 & b) or 'none')
        if ws >> 12 & 1: st += "; AsShotNeutral left (frame 1's not set)"
    elif ws & 0xFF == 1: st += ' (log 19: which sections not recorded)'
    out = [f"  white balance of the merged frame (final build): {st}",
           f"    frame 1:          {wbset_text(v['wbs1'])}",
           f"    merged, before:   {wbset_text(v['wbs4'][0])}",
           f"    merged, after:    {wbset_text(v['wbs4'][1])}"]
    for name, d in (('frame 1', v['awbd1']), ('merged ', v['awbd4'])):
        if d is None: out.append(f"    learned AWB at {name}'s Pipe1: no record"); continue
        out.append(f"    learned AWB at {name}'s Pipe1: path {d['cap_path']} ({PATHS.get(d['cap_path'], '?')}), mode {d['cap_mode']}, captures {d['caps']},"
                   f" gains R {d['cap_gr']} B {d['cap_gb']}, own (u, v) {d['cap_z']}, live view state {d['lv_mu']} (lv calls {d['lv_calls']}, done {d['lv_done']}),"
                   f" e30 {d['cap_e30']}, blocks {d['cap_valid']} / {d['cap_n']} valid")
    dm = v['tone_dmax_q16']
    out.append(f"    brightening d cap: {'none' if dm == 0x7FFFFFFF else 'not reached' if dm == 0 else f'{dm / 65536:.3f} stop'};"
               f" menu line {'yes' if v['tone_menu'] & 0xFF else 'no'}, old menu byte {v['tone_menu'] >> 8 & 0xFF:#x}{' (ignored)' if not v['tone_menu'] & 0xFF else ''}")
    return out


def review_text(v):
    r = v['rv_ret']
    if not r: return '  instant review stop (UI task, 0.5 s into the merge): not tried'
    why = {0xEEEF: 'not called: no CaptureImageModel', 0xEEE3: 'not called: no review up (CIM+0x27 = 0)', 0xEEE4: 'not called: ready already seen (CIM+0x24)',
           0xEEE5: 'not called: not the shooting screen'}.get(r)
    return f"  instant review stop (UI task): {why or f'called, CIM+0x27 = {r >> 8 & 0xFF} +0x24 = {r >> 16 & 0xFF} after it'} at {v['rv_us'] / 1000:.0f} ms into the merge"


def hc_text(v):
    src = {0: 'not decided', 1: 'SI+0xBB7', 2: 'fallback by black (SI+0xBB7 not 0/1)'}.get(v['hc_src'], '?')
    out = [f"  weights' noise model (spec v9): highlight correction {'applied' if v['hc_applied'] else 'not applied'} ({src}), model ISO step {v['w_step']},"
           f" A {v['w_a']} B {v['w_b']}, shift {v['nshift_w']}, entries 0/16/128/255 {v['ntab_w']}"]
    fr = [f"{i + 1}: BB7={h['flags'] & 0xFF} 7E4={h['flags'] >> 8 & 0xFF}{' black>=2048' if h['flags'] >> 16 & 1 else ''}" for i, h in enumerate(v['hc']) if h['flags'] >> 24 & 1]
    if fr:
        out.append('    per frame: ' + '; '.join(fr))
        out.append('    SI+0xB80..0xBBF / +0x7E0..0x7E7 per frame: ' + ' | '.join(' '.join(f'{x:08x}' for x in h['si_b80'] + h['si_7e0']) for h in v['hc'] if h['flags'] >> 24 & 1))
    return out


def summary_v12(v):
    if not v['parts_tries']: return ['  merge memory in parts: not asked', review_text(v)] + hc_text(v)
    mb = lambda x: f'{x / 2**20:.1f}'
    out = [f"  merge memory in parts: {v['parts_tries']} tr{'y' if v['parts_tries'] == 1 else 'ies'}, last for {v['parts_threads']} thread(s), output rows 0..{v['out_split'] - 1} over part 0, the rest over part 1"]
    for t in range(v['parts_tries']):
        pools = ', '.join(f'{mb(a)}/{mb(b)}' for a, b in v['part_pool'][t])
        out.append(f"    try {t + 1}: parts {[mb(z) + ' MB' for z in v['part_size'][t]]} at {[hex(a) for a in v['part_addr'][t]]};"
                   f" IMAGE2 free/largest MB before and after each block (largest first): {pools}")
    return out + [review_text(v)] + hc_text(v)


def summary_tap(t):
    """the tap block (mf14): H2's calls, oldest first"""
    out = [f"  one press = 4 frames (H2): {t['h2_seq']} calls since power-on, {t['h2_cont']} answered 'no stop' (limit {t['h2_limit_us'] / 1e6:g} s); last calls"
           " (count, seen, answer, age of H1's continue):"]
    for e in t['ring']:
        seen = '+'.join(n for j, n in enumerate(H2_FLAGS) if e['flags'] >> j & 1) or '-'
        age = '-' if e['age_us'] == 0xFFFFFFFF else f"{e['age_us'] / 1000:.0f} ms"
        out.append(f"    count {e['count']}: {seen}; answer {e['answer']}, age {age}")
    return out


def summary_v11(v):
    mb = lambda x: x >> 20
    ms = lambda x: f'{x / 1000:.0f} ms'
    st = {0: 'empty', 1: 'held', 2: 'released by stock', 3: 'moved by stock', 0xFF: 'not held'}
    fin = {0: '-', 1: 'freed by us', 2: 'given back to stock', 3: 'stock freed it (moved)'}
    site = {0: '-', 1: 'ReleaseBufferSingle', 2: 'ReleaseAll', 3: 'relocation', 4: 'another caller'}
    can = {0: '-', 1: 'same', 2: 'CHANGED', 3: 'FREED (pool header)'}
    out = [f"  hold (rule: IMAGE2 largest >= {mb(v['hold_rule'])} MB): our Free calls {v['hold_frees']}; merge block layout "
           f"{ {0: '-', 1: 'output over the pyramids', 2: 'separate output', 3: 'in parts (version 12)'}.get(v['merge_layout'], '?') } (room {mb(v['out_room'])} MB)"]
    for i, h in enumerate(v['hold']):
        if not h['raw'] and h['st_merge'] in (0, 0xFF): continue
        out.append(f"    frame {i + 1}: {h['raw']:#x} px {h['px']:#x}; at frame 4 {st.get(h['st_merge'], h['st_merge'])}, end {fin.get(h['final'], h['final'])},"
                   f" site {site.get(h['site'], h['site'])} (return {h['caller']:#x}), repeated frees {h['dup']}; canary before {can.get(h['canary_before'])}, after {can.get(h['canary_after'])}")
    for p, name in ((0, 'frame 1'), (1, 'frame 4')):
        rs = v['rec'][p]
        out.append(f"  recipes at {name} ({v['rec_n'][p]} valid):")
        for k, r in enumerate(rs):
            if r: out.append(f"    #{k}: step {r['step']} raw_done {r['raw_done']} seq {r['seqtype']} demand {r['demand']} held {r['held_ids']} {mb(r['sizes_sum'])} MB"
                             f" {[(BUFS[i - 1], hex(a), mb(z)) for i, (a, z) in r['bufs'].items()]}")
    out.append(f"  threads: shortest phase-2 job {[f'{x} us' for x in v['job_min_p2_us']]}; inside jobs phase 1 {[ms(x) for x in v['busy_p_us'][0]]},"
               f" phase 2 {[ms(x) for x in v['busy_p_us'][1]]}; this task waited {[ms(x) for x in v['m_wait_p_us']]} (phase 1, 2);"
               f" workers waited for go {[ms(x) for x in v['w_idle_us']]}; rounds {v['rounds_p']}; phase 2 began at {ms(v['t_p2_us'])}")
    r = v['prev_app_ret']
    app = '-' if not r else ({0xEEEF: 'no App object', 0xEEE1: 'App busy, not called', 0xEEE2: 'App holds a callback, not called'}.get(r, f'returned {r - 1}'))
    out.append(f"  after the previous group: re-posted start {'returned ' + str(v['prev_lv_start_ret'] - 1) + ' after ' + ms(v['prev_lv_start_us']) if v['prev_lv_start_ret'] else 'not seen'};"
               f" App live-view Start {app}{' after ' + ms(v['prev_app_us']) if r and r < 0xEEE0 else ''}")
    if v['prev_post']:
        f = lambda w1, w2: (f"{(w1 & 0xFFFF) * 32768 / 27000:.0f} ms", f"LVC58={w1 >> 16 & 0xFF} 59={w1 >> 24}",
                            f"App8={w2 & 0xFF} 9={w2 >> 8 & 0xFF} A={w2 >> 16 & 0xFF}", f"CIM24={w2 >> 24 & 15} 27={w2 >> 28}")
        out.append('    samples (screen, time since the end, live-view control, App live view, review flags): '
                   + '; '.join(f"{a:#x} {' '.join(f(b, c))}" for a, b, c in v['prev_post']))
    return out


def summary_v8(v, h1):
    """the version 8 probes, readable"""
    c = lambda x: f'core {x - 1}' if x else '-'
    mb = lambda x: x >> 20
    ms = lambda x: f'{x / 1000:.0f} ms'
    out = [f"  cores: this task {c(v['core_start'])} at the start, stop checks per core 0-3 {v['core_checks']}; workers {[f'{c(a)} -> {c(b)}' for a, b in v['w_core']]}"]
    out.append(f"  jobs phase 1 / phase 2 per thread (this task, worker 1, worker 2): {v['jobs_p1']} / {v['jobs_p2']}; inside jobs {[ms(x) for x in v['job_busy_us']]},"
               f" longest job {[f'{x} us' for x in v['job_max_us']]}; {v['rounds']} rounds, this task waited {ms(v['m_wait_us'])} for the workers")
    out.append(f"  workers: go signal -> running summed {[ms(x) for x in v['w_wake_sum_us']]}, longest {[f'{x} us' for x in v['w_wake_max_us']]}; deepest stack {v['w_stack']} bytes")
    out.append(f"  times from the merge's start: reference pyramid {ms(v['t_ref_us']) if v['t_ref_us'] else '-'}, write-back done {ms(v['t_written_us']) if v['t_written_us'] else '-'};"
               f" the previous log file took {ms(v['prev_log_us'])} to write")
    if v['bw_bytes']:
        rate = lambda us: f'{v["bw_bytes"] / (us - 1):.0f} MB/s' if us > 1 else ('0 us' if us == 1 else '-')
        out.append(f"  memory (once per power-on, {mb(v['bw_bytes'])} MB per thread, prefetcher on): 1 thread {[rate(x) for x in v['bw_us'][0][:1]]},"
                   f" 2 threads {[rate(x) for x in v['bw_us'][1][:2]]}, 3 threads {[rate(x) for x in v['bw_us'][2]]}")
    u = v['ui']
    span, gap = (u['first'] - u['last']) & 0xFFFFFFFF, u['max_gap']
    span -= TICK_RELOAD_EXCESS if span >= TICK_RELOAD_EXCESS else 0
    gap_txt = (f"longest gap {gap / 27000:.0f} ms" if gap < TICK_RELOAD_EXCESS else
               f"the tick reloaded between two redraws ({(gap - TICK_RELOAD_EXCESS) / 27000:.0f} ms apart; raw {gap / 27000:.0f} ms; the longest gap is not known)")
    out.append(f"  indicator: {v['wakes']} wake-ups posted; the UI task drew it {u['draws']} times (last on {c(u['core'])}), from first to last"
               f" {span / 27000:.0f} ms, {gap_txt}, root check failed {u['vt_fail']};"
               f" last word {v['progress_end']} ({'written back' if v['progress_end'] == 101 else str(max(0, v['progress_end'] - 1)) + ' %' if v['progress_end'] else '-'})")
    pe = v['pools_end']
    out.append(f"  pools after the group's blocks were freed: IMAGE1 {mb(pe[0])}/{mb(pe[1])} MB, IMAGE2 {mb(pe[2])}/{mb(pe[3])} MB")
    out.append(f"  front-end ring (count, answer, ISO step, gate): {[(e['count'], e['answer'], i['iso'], 'gate' if i['gated'] else ('memory' if i.get('mem') else '')) for e, i in zip(h1, v['h1_iso']) if e['tick']]}")
    return out


def summary_v13(v):
    ms = lambda x: f'{x / 1000:.0f}'
    al = ', '.join(f"{STAGES[i]} {ms(v['st_us'][i])}" for i in range(5))
    mg = v['st_us'][5:8]; tail = v['st_tail_us'][6]
    return [f"  stages (ms, spec v{v['spec']}): alignment {ms(sum(v['st_us'][:5]))} = {al}; merge {ms(sum(mg))} = setup {ms(mg[0])}, rows all threads"
            f" {ms(max(mg[1] - tail, 0))}, rows tail {ms(tail)}, after rows {ms(mg[2])}",
            f"    threads' tail per stage (ms) {[ms(x) for x in v['st_tail_us']]}, rounds {v['st_rounds']}"]


def summary_v14(v):
    r = v['prev_fb_ret']
    why = {0: 'not reached (no previous group, or its 5 s window ended before 3 s)', 0xEEE1: 'a group was active', 0xEEE5: 'not the shooting screen',
           0xEEE2: 'live view ran (nothing to do)', 0xEEEF: 'no LiveViewControl / sequencer noted'}.get(r)
    txt = why if why else f"restart re-posted, the post returned {r & 0xFFFF:#x}"
    return [f"  after the previous group, 3 s fallback (UI task): {txt}{' at ' + str(v['prev_fb_us'] // 1000) + ' ms' if r else ''};"
            f" instant review stop during the merge {'on' if v['review_stop'] else 'off (mf16)'}"]


def summary_v15(v):
    f32s = lambda u: f'{f32(u):.3f}'
    ev = lambda e: '-' if e == 0x7FFFFFFF else f'{e / 256:.2f}'
    hw = {1: 'hidden', 2: 'vtable not the still recipe', 3: 'sequence type', 4: 'last frame of the burst (kept)', 5: 'already set'}
    eqm = ['ELA (10)', 'WB_CALC (2)', 'Pipe1 (4)', 'JPEG_ENC (7)']
    out = [f"  night mode build: {[n for i, n in enumerate(BF) if v['build_flags'] >> i & 1]}; EV gate {v['ev_gate'] / 256:.2f}",
           f"    per frame EV100 {[ev(e) for e in v['ev256']]}, gate {v['gate']} (1 ISO, 2 EV, 3 both); hide {[(hw.get(h >> 16, '-'), h & 0xFF, h >> 8 & 0xFF) for h in v['hide']]}",
           f"    end: power key {v['shut']} (1 stopped the merge, 2 seen at the end), LVC +0xE3/+0x58 {v['lv_e3']:#x}, FE plans {v['fe_plans']:#x}, H2 calls at the hold {v['arm_h2']} / end {v['h2_end']}"]
    if v['sv_nom']:
        out.append(f"    merged frame: Sv {f32s(v['sv_nom'])} -> equivalent {f32s(v['sv_eq'])} (index {v['idx_eq']}); NR setting {v['nrset_nom']}; ELA byte prepared "
                   f"{v['nr_prep'] - 1 if v['nr_prep'] else '-'} -> {(v['nr_new'] & 0xFF) - 1 if v['nr_new'] else 'not recomputed'} (ElaNoise demand {v['nr_new'] >> 8})")
        out.append('    SI+0xBA0 at the modules (found -> left): ' + '; '.join(f"{eqm[i]} {f32s(v['eq_mod'][2 * i])} -> {f32s(v['eq_mod'][2 * i + 1])}" for i in range(4) if v['eq_mod'][2 * i] or v['eq_mod'][2 * i + 1]))
    wb = lambda a, b: [a & 0xFFFF, a >> 16, b & 0xFFFF, b >> 16]
    out.append(f"    white balance: frame 1 {wb(*v['wb1'])}; merged frame before {wb(*v['wb4'][0:2])} after {wb(*v['wb4'][2:4])}; state "
               f"{ {0: 'not reached', 1: 'written', 2: 'frame 1 not seen', 3: 'equal already', 4: 'off'}.get(v['wb_state'], v['wb_state']) }")
    r = v['tone_ret']
    # tone_ret = the return + 1 once it ran (0xEEE0 first: so with the menu on, 0 means -1, NT_ERR_ARG)
    tr = 'not run' if not v['tone_on'] else ('skipped (frame size / CFA)' if r == 0xEEE0 else ('ok' if r == 1 else f"error {((r - 1) & 0xFFFFFFFF) - (1 << 32) if (r - 1) & 0x80000000 else r - 1}"))
    q = v['tone_q16']
    out.append(f"    brightening: menu {'on' if v['tone_on'] else 'off'}, {tr}, {v['tone_us'] / 1000:.0f} ms (init/pass 1/plan at {[x // 1000 for x in v['tone_t']]} ms);"
               f" g {q[0] / 65536:+.3f} d {q[1] / 65536:+.3f} N {q[2] / 65536:.3f} g_full {('>= ' + format(G_FULL_MAX, '.2f') + ' (the AGC limit: 8 rounds of x10)') if q[3] / 65536 >= G_FULL_MAX - 0.01 else format(q[3] / 65536, '+.3f')} g_cap {q[4] / 65536:+.3f}, dark lift {v['tone_lift_q8'] / 256:+.3f} -> {v['boost8']}/8 stop;"
               f" changed {v['tone_changed']}; clipped {v['tone_clip'][0]} -> {v['tone_clip'][1]}; wb {v['tone_wb']} scale {v['tone_scale_q16'] / 65536:.4f} ISO {v['tone_iso']}")
    out.append(f"    settings: flags {v['nb_flags']:#x} (1 limits ours, 2 drive switched), slowest shutter {f32s(v['tvmin'])} upper {f32s(v['isoup'])} (user's {f32s(v['user_tvmin'])} / {f32s(v['user_isoup'])});"
               f" live-view drive switches {v['nd_switches'] & 0xFFFF} on / {v['nd_switches'] >> 16} back, last live EV {ev(v['nd_ev'])}; UI calls {v['ui_ticks']}; press files {v['press_files']}")
    return out


def rv_text(r):
    if not r['ret'] and not r['calls']: return 'not armed (no merged group, or REVIEW_ARM off)'
    why = {0xEEE1: 'not armed: a group active', 0xEEE3: 'not armed: CIM+0x27 already 1', 0xEEE4: 'not armed: CIM+0x24 already 1',
           0xEEE5: 'not armed: not the shooting screen', 0xEEE6: 'not armed: shutting down', 0xEEEF: 'not armed: no CaptureImageModel'}
    t = lambda x: '-' if not x else f"{(x - 1) / 1000:.0f} ms"
    rt = r['review_ms']
    rtx = 'off' if rt == 0 else ('hold' if rt == 0xFFFFFFFF else f'{rt} ms')
    a = why.get(r['ret'], f"armed (CIM+0x27 {r['ret'] >> 8 & 0xFF}, +0x24 {r['ret'] >> 16 & 0xFF} after)" if r['ret'] & 0xFF == 1 else f"{r['ret']:#x}")
    last = r['last']
    return (f"{a} {t(r['arm_us'])} after the end, review time {rtx}; watch: {r['calls']} UI loops, longest pause {r['gap_us'] / 1000:.0f} ms from {t(r['gap_at_us'])};"
            f" +0x24 = 1 at {t(r['t24_us'])}, +0x27 back to 0 at {t(r['t27off_us'])}, another screen at {t(r['tscreen_us'])}"
            f"{' (' + hex(r['screen']) + ')' if r['tscreen_us'] else ''}, shooting screen again at {t(r['tback_us'])}, live view at {t(r['tlv_us'])};"
            f" last +0x24 {last & 0xFF} +0x27 {last >> 8 & 0xFF} LVC58 {last >> 16 & 0xFF} shooting {last >> 24}; window {t(r['end_us']) if r['end_us'] else 'running'}")


def summary_v16(v):
    nm = v['tone_nmax_q16']
    cap = 'none' if nm == 0x7FFFFFFF else ('not reached' if nm == 0 else f'{nm / 65536:.3f} stop')
    sw = v['shutter_word']
    return [f"  review (mf18): window {v['rv_win_us'] / 1e6:g} s; this group: {rv_text(v['rv'])}",
            f"    previous group: {rv_text(v['prev_rv'])}",
            f"    brightening cap (N, g + d at most): {cap}; shutter cap hook at 0x536A7D1C: {'none (stock word)' if sw == 0xED900A1D else 'installed (' + hex(sw) + ')'}"]


PRESS = [('magic', 1), ('version', 1), ('bytes', 1), ('tick', 1), ('since_end_us', 1), ('fb_ret', 1), ('fb_us', 1), ('post_n', 1), ('post', 60),
         ('h1_seq', 1), ('h1', 64), ('h1_iso', 16), ('h2_seq', 1), ('h2_cont', 1), ('h2', 80), ('mem_total_last', 1), ('mem_gate', 1), ('img2', 2),
         ('sv', 1), ('tv', 1), ('av', 1), ('index', 1), ('drive', 1), ('seqtype', 1), ('develop', 1), ('dng', 1), ('ev256', 1), ('iso', 1),
         ('lv', 4), ('fe_plans', 1), ('nb_flags', 1), ('nd_dark', 1), ('nd_switches', 1), ('nd_ev', 1), ('phase', 1), ('count', 1), ('result_prev', 1)]
PRESS_LEN = sum(n for _, n in PRESS)
PRESS2 = PRESS + [('rv', RV_LEN)]          # version 2 (mf18)
PRESS2_LEN = sum(n for _, n in PRESS2)
PRESS3 = PRESS2 + [('asn_state', 1), ('asn1', 8), ('asn4', 16), ('bem', 16), ('evl', EVL_LEN)]   # version 3 (mf19)
PRESS3_LEN = sum(n for _, n in PRESS3)
PRESS4 = PRESS3 + [('dv', DV_LEN)]       # version 4 (mf21)
PRESS4_LEN = sum(n for _, n in PRESS4)
PRESS5 = PRESS3 + [('dv', DV20_LEN)]     # version 5 (mf22)
PRESS5_LEN = sum(n for _, n in PRESS5)
PRESS6 = PRESS3 + [('dv', DV21_LEN)]     # version 6 (mf23)
PRESS6_LEN = sum(n for _, n in PRESS6)


def parse_press(b):
    ver = struct.unpack_from('<2I', b)[1]
    lay, ln = (PRESS6, PRESS6_LEN) if ver >= 6 else (PRESS5, PRESS5_LEN) if ver >= 5 else (PRESS4, PRESS4_LEN) if ver >= 4 else (PRESS3, PRESS3_LEN) if ver >= 3 else (PRESS2, PRESS2_LEN) if ver >= 2 else (PRESS, PRESS_LEN)
    w = struct.unpack_from(f'<{ln}I', b); o = 0; p = {}
    for name, n in lay:
        p[name] = list(w[o:o + n]) if n > 1 else w[o]; o += n
    if p['magic'] != 0x474C504D or p['bytes'] != 4 * ln: raise ValueError('not a press log')
    if 'rv' in p: p['rv'] = rv_of(p['rv'])
    if 'dv' in p: p['dv'] = dv_of(p['dv'], ver >= 5, ver >= 6)
    if 'evl' in p:
        p['evl'] = ev_of(p['evl']); p['bem'] = [p['bem'][4 * k:4 * k + 4] for k in range(4)]; p['asn4'] = [p['asn4'][:8], p['asn4'][8:]]
    sg = lambda x: (x ^ 0x80000000) - 0x80000000
    p['ev256'] = sg(p['ev256']); p['iso'] = sg(p['iso']); p['nd_ev'] = sg(p['nd_ev'])
    p['h1'] = [dict(zip(('tick', 'count', 'stock', 'answer'), p['h1'][4 * i:4 * i + 4])) for i in range(16)]
    ring = [p['h2'][5 * i:5 * i + 5] for i in range(16)]
    p['h2'] = [dict(zip(('tick', 'count', 'flags', 'answer', 'age_us'), e)) for e in (ring[(p['h2_seq'] + i) % 16] for i in range(16)) if e[0] or e[2]]
    p['post'] = [tuple(p['post'][3 * i:3 * i + 3]) for i in range(min(20, p['post_n']))]
    return p


def summary_press(p):
    fb = {0: 'not reached', 0xEEE7: 'would have posted (mf17: notes only)', 0xEEE1: 'a group active', 0xEEE5: 'not the shooting screen',
          0xEEE2: 'live view ran', 0xEEEF: 'objects not known'}.get(p['fb_ret'], f"posted, returned {p['fb_ret'] & 0xFFFF:#x}")
    lv = p['lv'][2]
    out = [f"press: frame index {p['index']} drive {p['drive']} seq {p['seqtype']} dng {p['dng']} Tv {f32(p['tv']):.3f} Av {f32(p['av']):.3f} Sv {f32(p['sv']):.3f}"
           f" (EV100 {'-' if p['ev256'] == 0x7FFFFFFF else round(p['ev256'] / 256, 2)}, ISO step {p['iso']})",
           f"  {'-' if p['since_end_us'] == 0xFFFFFFFF else str(p['since_end_us'] // 1000) + ' ms'} after the last group's end; its 3 s rule: {fb}"
           f"{' at ' + str(p['fb_us'] // 1000) + ' ms' if p['fb_ret'] else ''}; {p['post_n']} UI samples",
           f"  live view: held {p['lv'][0]}, deferred {p['lv'][1]}, LVC +0x58 {lv & 0xFF if lv != 0xFFFF else '-'} +0xE3 {lv >> 8 if lv != 0xFFFF else '-'}, UI hold {p['lv'][3]};"
           f" FE plans {p['fe_plans']:#x}; IMAGE2 {p['img2'][0] >> 20}/{p['img2'][1] >> 20} MB (front end's last total {p['mem_total_last'] >> 20} MB, gate {p['mem_gate']})",
           f"  back end: phase {p['phase']} count {p['count']} previous result {RESULTS[p['result_prev']] if p['result_prev'] < len(RESULTS) else p['result_prev']};"
           f" night: flags {p['nb_flags']:#x} dark {p['nd_dark']} switches {p['nd_switches'] & 0xFFFF}/{p['nd_switches'] >> 16} live EV {'-' if p['nd_ev'] == 0x7FFFFFFF else round(p['nd_ev'] / 256, 2)}",
           f"  H1 ring (count, answer): {[(e['count'], e['answer']) for e in p['h1'] if e['tick']]}; H2 {p['h2_seq']} calls: {[(e['count'], e['flags'], e['answer']) for e in p['h2']]}"]
    if 'rv' in p: out.append(f"  review of the last merged group (mf18): {rv_text(p['rv'])}")
    if 'dv' in p: out += ['  display of the last group (mf21): ' + t for t in dv_text(p['dv'])]
    if 'evl' in p:
        out.append(f"  previous group: {asn_text(p['asn_state'], p['asn1'], p['asn4'])}; module marks (ms after this press's tick: negative = earlier):"
                   f" {[[round(-tdiff(t, p['tick']) / 1000) if t else '-' for t in r] for r in p['bem']]} (modules 14, 6, 7, 8 per frame)")
        # times after the last group's end: since_end_us - (this press's tick - event tick)
        end_tick = (p['tick'] + int(p['since_end_us'] * 27)) & 0xFFFFFFFF if p['since_end_us'] != 0xFFFFFFFF else p['tick']
        out += timeline(p['evl'], end_tick, 'timeline (ms after the last group\'s end)' if p['since_end_us'] != 0xFFFFFFFF else 'timeline (ms from this press back... absolute order)')
    return '\n'.join(out)


def asn_text(st, a1, a4):
    r = lambda w: '-' if not w[1] or not w[3] or not w[7] else f"{w[0] / w[1]:.4f} {w[2] / w[3]:.4f} {w[6] / w[7]:.4f}"
    name = {0: 'not reached', 1: "frame 1's written", 2: 'frame 1 not seen', 3: 'frame 1 not set', 4: 'equal already'}.get(st, str(st))
    return f"AsShotNeutral {name} (frame 1 {r(a1)}, merged before {r(a4[0])} after {r(a4[1])})"


def summary(g):
    if g.get('kind') == 'press': return summary_press(g)
    if g.get('version') != 2: return summary1(g)
    mb = lambda x: x >> 20
    out = [f"{g['result_text']}: {g['frames']} frames {g['width']}x{g['height']} black {g['black']} white used {g['white']}{' vmax ' + str(g['vmax']) if 'vmax' in g else ''} ISO step {g['iso_step']}{' (gate ' + str(g['iso_gate']) + ')' if 'iso_gate' in g else ''}, {g['n_alt']} alternates"]
    for i, f in enumerate(g['f'][:max(1, min(g['frames'], 4))]):
        out.append(f"  frame {i + 1}: gap {f['gap_us'] / 1000:.0f} ms copy {f['copy_us'] / 1000:.0f} ms index {f['index']} Tv {f['tv_f']:.3f} Av {f['av_f']:.3f} Sv {f['sv_f']:.3f} {f['flag_text']}"
                   f" IMAGE1 {mb(f['img1_total'])}/{mb(f['img1_largest'])} IMAGE2 {mb(f['img2_total'])}/{mb(f['img2_largest'])} MB, after our block {mb(f['img2_after'])} MB; white field {f['white_si']}")
    pm = g['pools_merge']
    out.append(f"  merge block {mb(g['need'])} MB from IMAGE{2 if g['block_pool'] else 1} at {g['block']:#x} (pools then: IMAGE1 {mb(pm[0])}/{mb(pm[1])}, IMAGE2 {mb(pm[2])}/{mb(pm[3])} MB);"
               f" merge {g['merge_us'] / 1000:.0f} ms (align done at {[x // 1000 for x in g['align_us'][:3]]} ms), written {g['written']}, NR byte {g['nr_before']}->{g['nr_after']}")
    out.append(f"  k {[round(k / 4096, 4) for k in g['k_q12'][:3]]} used {g['used'][:3]} offsets {list(zip(g['gy'][:3], g['gx'][:3]))} mean weight {g['mean_weight']}")
    if g.get('pmin') and g['pmin'][5]:
        p = g['pmin']
        out.append(f"  since the previous log, over {p[5]} module calls: IMAGE1 lowest {mb(p[0])}/{mb(p[1])} MB (largest block lowest at module {p[2]}), IMAGE2 lowest {mb(p[3])}/{mb(p[4])} MB")
    ab = f", ACTLR before the merge {g['actlr_before']:#x}" if 'actlr_before' in g else ''
    if g.get('bench') and g['bench'][0]:
        b = g['bench']; rate = lambda us: f"{32e6 / us:.0f} MB/s" if us else '-'
        out.append(f"  CPU: MIDR {b[0]:#x} ACTLR {b[1]:#x} SCTLR {b[2]:#x} CLIDR {b[3]:#x} L1D {b[4]:#x} L2 {b[5]:#x}; {b[7] / b[6]:.0f} MHz{ab}" if b[6] else f'  CPU: -{ab}')
        out.append(f"  32 MB copy: word loop {rate(b[6])}, stock memcpy {rate(b[8])}, loop + read-ahead hints {rate(b[9])}, loop with the hardware prefetcher on (ACTLR {b[10]:#x}) {rate(b[11])}")
    elif ab: out.append(f"  CPU:{ab[1:]}")
    if 'mt' in g:
        m = g['mt']
        fail = f", first failing kernel call: {MT_FAIL.get(m['fail_step'], m['fail_step'])} -> {m['fail_code']:#x}" if m['fail_step'] else ''
        out.append(f"  threads {m['threads']} (workers priority {m['pri']}, stack {m['stack']} bytes; set up in {m['setup_us']} us){fail}; phase 1 (alignment) done at"
                   f" {m['phase1_us'] / 1000:.0f} ms, phase 2 at {m['phase2_us'] / 1000:.0f} ms; jobs per thread {m['jobs']}, workers busy {[x // 1000 for x in m['busy_us']]} ms,"
                   f" ACTLR found {[hex(x) for x in m['actlr']]}")
    if 'v8' in g: out += summary_v8(g['v8'], g['h1'])
    if 'v9' in g:
        v = g['v9']
        out.append(f"  NR byte per frame before it was set to 0: {[x - 1 if x else '-' for x in v['nr_frame']]}; memory gate {v['mem_gate_bytes'] >> 20} MB:"
                   f" {v['mem_gated']} shots stopped at frame 1 since the previous log ({v['mem_skipped']} such frames left alone by the back end),"
                   f" IMAGE2 free at the last frame-1 decision {v['mem_total_last'] >> 20} MB")
    if 'v11' in g: out += summary_v11(g['v11'])
    if 'v12' in g: out += summary_v12(g['v12'])
    if 'v13' in g: out += summary_v13(g['v13'])
    if 'v14' in g: out += summary_v14(g['v14'])
    if 'v15' in g: out += summary_v15(g['v15'])
    if 'v16' in g: out += summary_v16(g['v16'])
    if 'v17' in g:
        v = g['v17']; t0 = g['f'][3]['tick'] if g['frames'] >= 4 else g['f'][0]['tick']
        out.append(f"  module marks (ms after frame 4's module 9; modules 14, 6, 7, 8): {[[round(tdiff(t0, t) / 1000) if t else '-' for t in r] for r in v['bem']]}")
        out.append(f"  {asn_text(v['asn_state'], v['asn1'], v['asn4'])} (the store comes after this log; the next press log has it)")
        out += timeline(v['evl'], t0, "timeline (ms after frame 4's module 9)")
    if 'v18' in g: out += summary_v18(g['v18'])
    if 'v19' in g:
        out += ['  display, the previous group (mf21): ' + t for t in dv_text(g['v19']['prev_dv'])]
        out += ['  display, this group: ' + t for t in dv_text(g['v19']['dv'])]
    if 'v21' in g:
        v = g['v21']
        out.append(f"  log written after a wait of {v['log_wait_us'] / 1000:.0f} ms at the merged frame's module 7 ({LOG_WAIT.get(v['log_wait_why'], v['log_wait_why'])})")
    if 'v22' in g:
        v = g['v22']; f = v['keep_flags']
        out.append(f"  build: KEEP_LAST_ONLY {f & 1}, PROBES {f >> 1 & 1}, PROGRESS_BAR {f >> 2 & 1}; frames 1-3: {keep_text(v['keep'])}; previous group: {keep_text(v['prev_keep'])}")
    if 'v23' in g:
        ms = [m[0] for m in g['v19']['dv'].get('msmp', [])] if 'v19' in g else []
        out.append('  live view during the merge (recording build), per merge sample: ms, the live root rendered (reached our draw), our processing-screen'
                   ' draws, root invalidations asked / left marked (+0xA0):')
        out += [f"    {(ms[i] / 1000 if i < len(ms) else 0):6.0f} ms  root rendered {a}  drawn {b}  invalidated {c & 0xFFFF} / marked {c >> 16}" for i, (a, b, c) in enumerate(g['v23']['rd'])]
    if 'tap' in g: out += summary_tap(g['tap'])
    if 'v10' in g:
        v = g['v10']
        net = lambda n: ('-' if not n else ' + '.join(x for b, x in ((1, 'back end'), (2, 'UI watchdog'), (0x100, 'live view already running (stock start)')) if n & b))
        ret = v['lv_post_ret']
        out.append(f"  live view during the merge: group {v['ab_group'] - 1 if v['ab_group'] else '-'} = {' AB'[v['ab_letter']] if v['ab_letter'] < 3 else '?'}"
                   f" ({'restart held' if v['ab_letter'] == 1 else 'stock'}); starts skipped {v['lv_skips']}; re-post by {net(v['lv_net'])},"
                   f" {v['lv_defer_us'] / 1000:.0f} ms after the hold, post returned {ret & 0xffff:#x}{' retry ' + hex(ret >> 16) if ret >> 16 else ''};"
                   f" an earlier group's UI watchdog: {net(v['lv_prev_ui'])}")
        if 'v23' in g:                 # (version 23: these words are handnight.ts's live-view counters, shown with the merge samples above)
            out.append(f"  UI task during the group (recording build): the live root rendered {v['ui_calls']} times; root invalidations asked / marked: see above")
        else:
            out.append(f"  UI task during the group: live-view update ran {v['ui_calls']} times; samples (screen id, updates, indicator draws), once a second:"
                       f" {[(hex(a), b, c) for a, b, c in v['ui_samples']]}")
    return '\n'.join(out)


if __name__ == '__main__':
    for p in sys.argv[1:]:
        print(p); print(summary(parse(open(p, 'rb').read())))
