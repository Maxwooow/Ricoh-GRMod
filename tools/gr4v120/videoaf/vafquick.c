// SPDX-License-Identifier: GPL-2.0-only
/*
 * Movie AF, GR IV 1.20: the camera's own wobbling AF, steered by the image-plane phase data, with a recording.
 *
 * What the camera does while a movie is recorded (tools/gr4v120/videoaf/README.md):
 *  - every focusing frame goes to the wobbling module (CafWobbling, object + 0x15C8).  In its travel state
 *    (module + 0xE5 == 5) it votes over the focus areas (0x5362C1C8): 0 = the peak is passed, 1 = the focus is
 *    in direction 0, 2 = in direction 1, 3 = go on.  A vote against the direction of travel turns it round
 *    (0x5362F8E0 ..).  Then it sends one step of (count + 1) x basic step lens units (module + 0xC78, + 0x10),
 *    limited by + 0x1E, and waits for the lens.
 *  - once in focus it stands by; every frame a monitor (0x53621F6C) decides whether to search again, and asks
 *    for it with 0x53609BB0 (parent, 2, 2, 0).
 *  - the phase module (object + 0x60) gives, every frame, per area a value and a direction for all of them.
 *    Measured on six recordings with the lens's own position (value paired with the position 7 frames before,
 *    three or more reliable areas): remaining distance = 0.37 x median value (10th percentile 0.28) and the
 *    direction right in 99 % and more, for values of 150 and more.  After a fast move the value needs up to
 *    18 frames to show it (camera, 2026-11-14: unchanged for 11 frames after a 66 unit step, right after 18).
 *
 * What this module adds:
 *  0. what the phase data is taken to say.  A "strong" result has three reliable areas and a value of STRONG_FROM
 *     or more.  The module acts only on AGREE strong results in a row for the same direction, the later one at
 *     most RECENT frames old; results from fewer areas for the same direction, and frames without a result,
 *     neither count nor break the row; a result for the other direction, or three areas saying "near", ends it.
 *     The row is counted in standby too, so a search starts with what the frames before it said.  Two values
 *     come from a row, both less what the lens has moved that way since LAG frames before the later result
 *     appeared (a result is 4 .. 6 frames behind the lens when it appears: camera, 2026-11-14, 29 fast steps):
 *     "left for certain", the smaller of the last two strong values, which the direction rules use; and "left
 *     for the step", the later value but at most 1.5 x the one before (one reading far above its neighbours
 *     happens when the scene changes).  A later result from fewer areas lowers both.
 *  1. step size (travel state, lens travelling the way of such a row): a fast step of FAST_Q8 of what is left
 *     for the step (about three quarters of the distance at the usual ratio), at least FAST_MIN (a further one
 *     in the same travel: FAST_AGAIN) and at most FAST_MAX units; it alone is marked for the lens's ordinary speed (state + 0x54, read by the speed stub).
 *     Not on the first step of a climb (module + 0xCB0 == 0): there the camera sets its count anew (0x5362FB28),
 *     so the fast step goes out one step later (in version 5 it was lost there and taken for sent).  It counts
 *     as sent only when the camera's step is the amount named (the camera's limit is set to it for that step).  While the lens moves and until LAG frames after
 *     it has stopped, results end the row (they were taken before or during the move); the steps then are quiet
 *     ones: two basic steps until 5/16 of the fast step have been added, then the smallest.  Without such a
 *     row, three reliable areas and the lens travelling the phase way: two basic steps while the value as it is
 *     says QUIET_FROM units or more, else the smallest; the phase direction against the travel and a small value
 *     (the focus was just passed): the smallest step.  Everything else is the camera's own count, unmarked.
 *  2. direction: with such a row and STRONG_FROM or more left for certain, the vote's result is replaced where
 *     it matters.  Against the row's direction the camera is made to turn round (its own code does it): within
 *     YOUNG frames of the travel's beginning or last turn on a row of AGREE (the camera's first direction is
 *     direction 1 nearly always, right or wrong: 6 of 9 searches for a near subject began the wrong way);
 *     later, when the camera has kept its direction for a while, only on a row of OLD_AGREE with OLD_FROM left
 *     (a subject leaving the picture gives a few strong results that point back at it).  When the camera wants
 *     to stop or turn while it travels the row's way, it goes on.
 *  3. trust: once the module steers, the phase value has to follow the lens: when the lens's own position has
 *     gone PROOF_UNITS the phase way (as far as a value PROOF_LAG frames old can show), the median must have
 *     fallen by at least that many; if not, or if votes were replaced for STALL_FRAMES frames without the lens
 *     getting that far, or after three forced turns in a short time, the module leaves the camera alone for
 *     DISTRUST_FRAMES frames, twice as long every further time (up to DISTRUST_MAX).
 *  4. standby: when the camera stands by although the row is RESTART_AGREE strong results long, the module asks
 *     for a new search the way the camera's monitor does, RESTART_WAIT frames after the standby began at the
 *     earliest.  If such a search ends within RESTART_PROOF units of where it began, the next one waits
 *     RESTART_PENALTY frames, twice as long every further time.
 *  5. keeping the focus without a search (version 7; flags bit 4).  The camera's own way while a movie is recorded:
 *     whenever its monitor finds the scene changed (the camera moved, something moved) it empties the phase
 *     computation every frame (0x536220D4 -> 0x5363EFE8) and, when the scene has settled, starts a whole new
 *     contrast search, which passes the focus and comes back: walking round a subject the picture goes out of
 *     focus and back again and again although the subject never left the focus.  Now, with the hook word
 *     0x5362208C (the phase computation is no longer emptied while recording):
 *     - a "follow row" is AGREE results in succession with three reliable areas, the same direction and a value
 *       of FOLLOW_FROM or more (FINE_FROM within EPISODE frames of a step; CALM_FROM for CALM frames after small
 *       steps to, fro and to again; for the far direction: not when two areas still read less than IN_AREA while
 *       the median is twice that, i.e. the subject has left only part of the frame);
 *     - in standby, on a follow row, the lens is sent straight there by the wobbling module's own lens move
 *       (0x536304BC: its backlash rule, its speed, the fast mark from FAST_MIN units on).  The lens takes a move only
 *       from who holds it (lens + 0x14, checked at 0x5360D9BC), and in standby nobody does: the camera takes it for
 *       the movie AF when a search begins (0x5362635C) and gives it back when the search ends (0x53613E2C).  Version 7
 *       did not know: on the camera (VQ621721, 2026-11-14) nine steps were sent and none taken, the module took
 *       that for a reason to leave the camera alone for 4, 8 and 16 s, and did not ask for a search either, so the
 *       picture stayed out of focus for up to 10 s.  Version 8 takes the lens the same way (0x5360D980 (lens, 2))
 *       and gives it back when it has stopped (0x5360DE18).  Whether the lens then moves, only the camera can show;
 *       so a step of DEAD_UNITS or more that has not moved the lens at all DEAD_FRAMES frames later (a taken one
 *       shows in the next frame) counts as not taken: the rows of results are put back as they were and a search
 *       is asked for in that frame (see below); if no step straight has ever moved the lens in this recording none
 *       is tried any more, else none for DIRECT_BLOCK frames after STUCK in a row.  Not taken is no reason to lose
 *       trust.  The step (see SHARE, SHARE_FAR_AGREE): near 0.19 x the first 100 of the value + 0.24 x the rest; far 0.31
 *       x the value when the areas agree, else 0.24; sized by the last value, at most twice the one before; a fast one from
 *       STEP_FAST units on.  Results count again LAG frames after the lens has stopped; within EPISODE frames of a
 *       step, a value for the same direction that is not more than 1.5 x the value before that step is "going
 *       on" if the value fell for that step as it should (FELL_Q8): one result is enough (sized by no more than
 *       the value before that step), and so on until the value is below
 *       the threshold; and when the lens then rests with the mean of the last results TRIM_FROM or more to one
 *       side, one small step for that.  A large value for the far direction that is not such a going on waits
 *       FAR_HOLD frames first: a subject slipping out of the frame for a moment must not send the lens to the
 *       background;
 *     - where no step straight is to be had (the lens takes none, or it is someone else's, or the trust is gone), the
 *       module asks for a search itself, as in 4: without trust on RESTART_AGREE strong results; else on AGREE
 *       results of ASK_FROM (a far subject of STRONG_FROM after FAR_HOLD frames);
 *     - when the camera's own decision wants a new search (0x536147F0), it is refused as long as the phase data
 *       was usable within the last BLIND frames and has not said "out of focus" for OUT_LIMIT frames without a
 *       step (where no step straight is to be had: as long as the last usable value is below QUIET_BELOW);
 *       otherwise the camera searches as before, steered as in 1 .. 4.  Refusing is not for ever: after VETO_CAP
 *       frames of it one search is let through; if the phase data then reads QUIET_BELOW or more at the place that
 *       search ended (twice), it does not agree with the picture and nothing is refused any more in this recording;
 *       else the limit is doubled;
 *     - a step of JUDGE_FROM units or more is judged by the first result after it (version 12, see judge_step): a
 *       value that has risen by two units per lens unit moved, two steps in a row, is a wrong phase direction: trust
 *       lost as in 3, until the camera's own search has had its turn.  So are FLIPS steps after which the value read
 *       as much on the other side.  A value that merely has not fallen (a subject moving away, one still coming in)
 *       only makes the next step wait for its own row; NOFALL in a row hand over to the camera for a while.  Nothing
 *       is taken back.  No step back the other way for LOCK_SHORT frames after a step where the value is LOCK_BIG or
 *       more, LOCK_LONG where it is less (Canon), and the camera's own search is refused for that time.  No step
 *       while a request for a search stands (object + 0x85CB).
 *     - version 12 also writes to the file what else the phase block holds and has never been looked at on a camera
 *       (struct zframe): the factory's own per-area lens targets, a direction per area, its quality flags, and the
 *       lens position the block was made with.
 * Starting, peak finding, the slow sweep and the return to the peak are the camera's own.
 *
 * Entry vafquick(ctx, which, argument, value):
 *   which 0: in place of the call of the wobbling step 0x5361ED88 at 0x53626104; argument = the CafProcess object.
 *   which 1: the object's "movie record state 0" callback has run (recording ended): the file is written.
 *   which 2: the travel state's vote has run (0x5362F6FC); argument = its result; returns the result to use.
 *   which 3: the standby monitor has run (0x536266E0); argument = the object, value = its "scene changed" flag.
 *   which 4: the camera's own decision is about to ask for a new search (0x536147F0); argument = the object;
 *            returns 1 (ask) or 0 (do not).
 * Position independent, no data section, no library calls.
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef short s16;
typedef unsigned int u32;
typedef int s32;
typedef u32 uptr;

struct ctx {
    u32 magic;
    uptr *slot;                             /* RAM word, zero at start-up */
    u32 flags;                              /* bit 0: step size, bit 1: direction, bit 2: recording file, bit 3: standby, bit 4: keeping the focus without a search */
    void *(*alloc)(u32);                    /* operator new */
    u8 *(*timer_holder)(void);              /* + 0xC: elapsed timer */
    u32 (*tick)(void *);
    u32 (*elapsed)(void *, u32, u32, u32);  /* (timer, earlier, later, 0) -> microseconds */
    u8 *(*file_holder)(void);               /* + 0x14: file service */
    u32 (*step)(u8 *, u32);                 /* 0x5361ED88, the wobbling step (object, 1) */
    s32 (*lens_position)(u8 *);             /* 0x5360DFF4 (lens) */
    u32 (*restart)(u8 *, u32, u32, u32);    /* 0x53609BB0 (object + 0x48, 2, 2, 0): ask for a new search */
    u32 (*lens_state)(u8 *, u32);           /* 0x5360E7B0 (object + 0x50, 0): 1 = no new search now */
    void (*move)(u8 *, u32, u32, u32);      /* 0x536304BC (wobbling module, amount, speed, 1): its lens move, direction from module + 0x21 */
    u32 (*acquire)(u8 *, u32);              /* 0x5360D980 (lens, 2): the lens is taken for the movie AF (1: it is ours) */
    u32 (*release)(u8 *, u32);              /* 0x5360DE18 (lens, 2): given back (0: not ours, or still moving) */
};

#define MAGIC 0x51414656u /* "VFAQ" */
#define VERSION 13
#define RECORDS 680u
#define NO_MARK 0xffffu
#define FAST_Q8 72u             /* 0.28 of the value (the 10th percentile of remaining / value): the fast step, and what a lens unit is worth in value (256 / 72) */
#define FAST_MIN 24u            /* the smallest fast step.  (A row is of values of 150 and more: below that 0.28 x value passed the focus in a quarter of the
                                   recorded frames.  What the lens has moved since is taken off, so the step can be smaller than 0.28 x 150 = 42.) */
#define FAST_AGAIN 42u          /* a further fast step in the same travel needs this much */
#define FAST_SEEN 42            /* lens units moved since a result was taken, from which that result is taken not to show a fast step yet */
#define FAST_MAX 200u
#define QUIET_COUNT 1u
#define QUIET_FROM 18u          /* lens units left by the value as it is, from which a quiet step is two basic steps */
#define AREAS 3u
#define STRONG_FROM 150u        /* a strong result: AREAS reliable areas and this value (direction right in 99 % of the recorded frames) */
#define AGREE 2u                /* strong results in a row for one direction before the module acts */
#define RECENT 12u              /* ... the later of them at most this many frames ago */
#define RUN_GAP 30u             /* a strong result this long after the last one starts a new row */
#define LAG 8u                  /* frames a result is taken to be behind the lens when it appears (measured 4 .. 6) */
#define STALE 20u               /* a result standing longer than this says nothing about the step size */
#define ARRIVED 6               /* lens units a frame: less, and a fast step has ended */
#define YOUNG 20u               /* frames after the travel began or turned in which AGREE results turn it round; later it takes OLD_AGREE of OLD_FROM */
#define OLD_AGREE 3u
#define OLD_FROM 180u
#define REVERSE_BLOCK 20u       /* frames between two forced turns */
#define REVERSAL_SCORE 60u      /* per forced turn; one less each frame: three turns within about 40 frames lose the trust */
#define REVERSAL_LIMIT 100u
#define CAMPAIGN_FROM 150u
#define PROOF_UNITS 50
#define PROOF_LAG 16u
#define STALL_FRAMES 120u
#define DISTRUST_FRAMES 240u
#define DISTRUST_MAX 3600u
#define RESTART_AGREE 4u
#define RESTART_FRESH 8u        /* the last strong result at most this many frames ago */
#define RESTART_WAIT 8u         /* frames of standby before the module may ask */
#define RESTART_RETRY 30u       /* frames between two requests */
#define RESTART_PROOF 15
#define RESTART_PENALTY 120u
#define FOLLOW_FROM 30u         /* a value from which the lens follows in standby (8 .. 13 lens units) */
#define FINE_FROM 26u           /* ... and from which it goes on within EPISODE frames of a step (5 .. 8 lens units) */
#define CALM_FROM 60u           /* the value it takes for CALM frames after small steps to, fro and to again */
#define CALM 240u
#define TRIM_FROM 14u           /* the lens at rest, every result below FOLLOW_FROM: the running mean (a new result has a quarter of the weight) from which a last small step is made */
#define TRIM_RESULTS 8u         /* ... after this many results at rest */
#define IN_AREA 40u             /* an area reading less than this is in focus */
#define SHARE 61u               /* 0.24: the share of the value a step straight from standby takes.  What a value unit was worth in lens units on the
                                   camera (two recordings of version 8, the whole way to the focus against the value the first step was sized by):
                                   0.24 .. 0.27 where the value had settled, more (up to 0.58) where the subject was still coming into the frame and
                                   the first value was too small; 0.31 .. 0.42 in four ways back to the background.  What single steps showed (lens
                                   movement / fall of the value) went from 0.16 to 0.78, the subject moving meanwhile, and the smallest of three of them
                                   held version 8 at 0.20: learning it from steps is gone.  (0.28 for the far direction passed the focus by 17 .. 25
                                   units in the closed loop where a value unit is worth 0.24 there too.) */
#define SHARE_SMALL 49u         /* 0.19 for the first SMALL_TO of a value: near the focus a value unit is worth less (camera, the last steps of twelve
                                   ways: 6 units left at a value of 34, 8 at 42 and 48, 16 at 94, 19 at 99; a larger share there passed the focus by 8
                                   units and one more step came back).  So a step is 0.19 x value up to SMALL_TO, and 0.19 x SMALL_TO + 0.24 x the rest
                                   beyond: 34 units for 165 (camera: 38 left), 51 for 236 (61), 87 for 384 (95), 170 for 731 (173) */
#define SMALL_TO 100u
#define STEP_FAST 6u            /* lens units from which a step straight is a fast one (version 8: 24, and the smaller ones crept at 120 units/s) */
#define FELL_Q8 142u            /* a step is taken to have done what the value said when the value fell by a unit per 0.55 lens units or more (142 / 256) */
/* Version 12: what other makers' published rules say, as far as this camera allows (README.md), and what the
   pooled recordings of versions 8 .. 11 show.  The four numbers below can be set from the compiler's command line for the comparison
   builds of sim_follow.py. */
#ifndef LAG_STOP
#define LAG_STOP 7u             /* frames after the lens was seen to have stopped (one frame after it did) from which results count again.  Canon subtracts
                                   the lens's travel since the measurement's exposure from every value; which exposure a result belongs to is not known
                                   here, only that a result is 3 .. 7 frames behind when it appears (camera, 60 large steps of versions 9 .. 11, records
                                   8 frames apart; an older measurement says up to 8).  So: results that appear 8 frames or more after the stop.  Up to
                                   version 11: 9 frames, and 11 for a single result.  The file now has the frames after the first large steps one by
                                   one (PROBES), to settle the number. */
#endif
#ifndef STEP_CAP
#define STEP_CAP 0u             /* the most lens units a step straight takes (0: no limit).  Olympus steps by bands of the defocus instead of the amount itself */
#endif
#ifndef GAIN_Q8
#define GAIN_Q8 256u            /* a factor on every step straight (256 = 1).  libcamera moves a small share of the error every frame */
#endif
#ifndef SHARE_FAR_AGREE
#define SHARE_FAR_AGREE 80u     /* 0.31 of the value for the far direction when the areas agree (largest - smallest <= 0.3 x median, four areas or more): the
                                   true distance was 0.31 .. 0.43 of the value there in 26 steps (10 %: 0.31, median 0.39) */
#endif
#define SHARE_FAR_MIXED 61u     /* 0.24 when they do not (10 %: 0.19, a quarter below 0.22 .. 0.29) */
#define WRONG 2u                /* steps in a row after which the value had risen by two units and more per lens unit moved, as a step the wrong way makes it
                                   (2.5 .. 5): the phase direction is wrong, trust lost.
                                   (A value that only fails to fall is a subject moving away, or one still coming into the frame: camera, version 11, trust
                                   lost on a hand moving away, and 12 s of the camera's own searches.) */
#define NOFALL 4u               /* steps in a row without the value falling: no step straight for DIRECT_BLOCK frames, the camera's turn (Fujifilm: contrast
                                   after N failures in a row) */
#define LOCK_BIG 90u            /* Canon: no step back the other way for 0.3 s where the defocus is large, for 1 s where it is small */
#define LOCK_SHORT 18u
#define LOCK_LONG 60u
#define PROBES 12u              /* the first steps of 40 units and more of a recording are followed frame by frame for PROBE_FRAMES frames (file only) */
#define PROBE_FRAMES 16u
#define PROBE_FROM 40u
#define WEAK_AGREE 4u           /* results in a row from one or two reliable areas, the same direction, STRONG_FROM or more, and none from three areas
                                   meanwhile: the lens goes there too.  (Camera, version 10: the hand gone, the background read far 267 .. 376 from one
                                   or two areas seven times in 0.9 s, nothing counted as usable, and after 45 frames the camera's own search was let
                                   through: 1.6 s.  In five recordings of versions 8 to 10 there is no such row while the picture was in focus.) */
#define WEAK_STEPS 3u           /* ... that many steps at most before three areas have agreed again */
#define FLIPS 3u                /* large steps to, fro and to again within FLIP_FRAMES: the phase data is not to be trusted */
#define FLIP_FRAMES 180u
#define JUDGE_FROM 24u          /* lens units from which a step is judged (a smaller one is within what a moving subject does meanwhile) */
#define STUCK 2u                /* steps in a row that moved the lens less than half way (the end of its range): no step straight for DIRECT_BLOCK frames */
#define DIRECT_BLOCK 120u
#define DEAD_UNITS 6u           /* a step straight of this size ... */
#define DEAD_FRAMES 3u          /* ... that has not moved the lens at all after this many frames was not taken (a taken one shows in the next frame) */
#define ASK_FROM 100u           /* no step straight to be had: the value from which the module asks for a search (two results) */
#define QUIET_BELOW 60u         /* ... and below which the camera's own new search is refused */
#define VETO_CAP 180u           /* frames the camera's wish to search is refused while the phase data says "in focus"; then one search is let through */
#define VETO_GAP 60u            /* frames without such a wish after which the count begins anew */
#define PROBE_RESULTS 2u        /* that search has ended on the contrast peak: if this many usable results in a row then read QUIET_BELOW or more, the phase
                                   data does not agree with the picture, and nothing is refused any more in this recording; else the limit is doubled */
#define PROBE_WAIT 45u          /* frames to wait for them */
#define FAR_HOLD 12u            /* frames a large value for the far direction has to stand before the lens goes there */
#define EPISODE 40u             /* ... unless a step that way was sent within this many frames */
#define REL_OK 64u              /* an area counts when its reliability is within the factory's own limit (0x53EE0CC8; read in 0x53634204).  Up to version 12
                                   the module counted areas up to 128.  Camera, versions 8 .. 12, 222 steps with the place the lens came to rest: with
                                   three areas within 64 the step was past the focus or the wrong way in 18 % and the distance was 0.35 x the value
                                   (median); with fewer, in 30 .. 50 %, and 0.19 .. 0.20 x.  In version 12's recordings no step of 100 and more on three
                                   such areas was followed by a step back (29 steps); on fewer, 12 .. 15 %.  In a room with a lamp in the picture half
                                   of the steps were on fewer. */
#define BLIND_MAX 600u          /* a search let through for want of phase data that ended with still none makes the next one wait: 120 frames more,
                                   twice as long each further time, up to this (Canon gives up after both ends; the camera's own search went from end
                                   to end for 4 .. 10 s again and again in the room with the lamp) */
#define BLIND 30u               /* frames without usable phase data after which the camera may search by itself */
#define OUT_LIMIT 90u           /* frames of "out of focus" without a step after which it may, too */
#define SERVO_WAIT 8u           /* standby frames before the first step */
#define STALL_TICKS 90u         /* frames of a recording after which ... */
#define STALL_RESULT 8u         /* ... a phase result that last changed before this frame means that there is no phase data at all: a 4K
                                   movie (`movie4k.ts`; the phase block is not filled for that read-out).  Camera, test firmware 094 against
                                   097: without this the focus stood still for the whole recording, every search refused */
#define STANDBY 0xeeu           /* "state" of a standby record */

struct record {                 /* 80 bytes */
    u32 t_us;
    u32 frame;                  /* focusing frame number in this recording */
    s32 lens;                   /* wobbling module + 0x134 (its own count) */
    s32 lens_real;              /* the lens's own position (0x5360DFF4); opposite sign */
    s32 count;                  /* + 0xC78 after the step.  Standby: frames of this standby */
    s16 own_count, count_before;/* the camera's own count as tracked here; + 0xC78 before this module wrote */
    u16 base, step, cap, wanted;/* + 0x10, + 0x1A, + 0x1E after the step; count written + 1 (0 = left alone) */
    u16 value[5];               /* phase block + 0x18 + 2 i */
    u16 median, median_used;    /* of the reliable areas; what the row of strong results says is left (0: no such row) */
    u16 steps_in_climb;         /* + 0xCB0 before the step */
    u16 lens_speed, last_amount;/* lens control object + 0x1E2 (speed of the last move); lens + 0x18 (its amount) */
    s16 moved;                  /* lens units moved the phase way since LAG frames before the result standing appeared */
    u8 reliability[5];          /* phase block + 0x209 + 9 i */
    u8 phase_of_step, verdict, direction, result;       /* + 0xE5 (0xEE: standby), + 0xE6, + 0x21 after the step; what the step returned.
                                                           Standby: object + 0x85CA, the monitor's "scene changed" flag, + 0x85CB */
    u8 total_direction, total_valid, running, reliable; /* phase block + 0x11, + 0x10, + 0x1560; areas with reliability <= 0x80 */
    u8 stock_verdict, forced, run;                      /* the vote's own result (0xFF: no vote this frame); what replaced it (0: nothing); strong results in a row */
    u8 motor, quiet, ready, returning;                  /* lens control object + 0x1E0, + 0x371; module + 9, + 0x20.
                                                           Standby: object + 0x10CA6, + 0x10BA8, + 0x85CC, + 0x85E5 */
    u8 settle, distrust, campaign, reverse_block;       /* frames until results count again (255: the fast step is under way; standby: frames / 16 before the module may ask);
                                                           distrust: frames left / 4; campaign: frames so far */
    u8 age, marks;                                      /* frames the result standing has stood; bit 0: the fast step was sent, 1: campaign started, 2: trust lost,
                                                           3: this step is the fast one, 4: fast step put off (first step of a climb), 5: new search asked for, 6: asked and refused.
                                                           Standby, version 7: step = lens units sent straight (marks bit 7), wanted = share x 256, cap = searches of the camera
                                                           refused since the last record (marks bit 4), own_count = follow row, count_before = areas in focus, moved = what the
                                                           value was worth in the last step (lens units x 256 per value unit), median_used = the value the step was sized by */
};

/* What else the phase result block holds (read in the code that fills it, 0x53638350 and 0x5363821C; never yet seen on the camera, so
   version 12 only writes it to the file):
     block + 0x14         the lens position of the lens sample the block was made with (lens object ring entry, 0x53638404)
     block + 0x162 + i    a direction per area (0x5363AACC)
     block + 0x208 + 9 i  per area: [0] = 1 when the correlation's bottom is good, [1] the low byte of the 16-bit reliability (the factory's own
                          limit is 64), [5] "fake bottom doubt", [6] saturation, [7] defect
     block + 0x1038 + 4 i, + 0x12CC + 4 i   per area, signed lens units: the upper and lower end of where the factory's own conversion puts the focus,
                          from the lens position of the block: (defocus +- a margin) x lens sensitivity / 256 - the lens's travel since the measured
                          frame's lens sample, + - 15.  Their middle is the factory's "how far from here". */
struct zframe {                 /* 36 bytes */
    s16 moved;                  /* lens units moved since the step was sent */
    u16 median;
    u8 flags, age;              /* flags: bit 0 direction, bits 1 .. 3 reliable areas, bit 4 valid, bit 5 a new result */
    s16 d14;                    /* block + 0x14 less the lens's own position now */
    u8 dirs, quality;           /* bit i: block + 0x162 + i; bit i: area i good by the factory's flags ([0] = 1, [5] = [6] = [7] = 0) */
    s16 mid[5];                 /* the middle of the factory's two ends, per area */
    u16 val[5];
    u8 rel[5], pad;
};
struct lagprobe {               /* 624 bytes */
    u32 tick;                   /* frame of the recording in which the step was sent */
    u16 units, by;
    u8 direction, spare[3];
    struct zframe pre;          /* the frame the step was sent in */
    struct zframe f[PROBE_FRAMES];
};
struct zaf { s32 d14, mid_median, mid[5]; u32 dirs, quality; };

struct state {
    u32 magic, version, record_bytes, records, dropped, files, first_tick, stops;
    u32 header_bytes;           /* where the records start */
    u32 frame_rate_bits;        /* object + 0x651C */
    u16 lens_speed[5];          /* object + 0x6576 .. + 0x657E */
    u16 lens_unit;              /* module + 0x3C */
    u32 aperture_bits;          /* module + 0x30 */
    u32 flags, frames;
    u32 forced, reversals, sized, distrusts;    /* in this recording: votes replaced, of them turns, fast steps sent, times trust was lost */
    u8 lens_index, lens_quiet, motor_ordinary, spare;   /* lens control object + 0x78, + 0x371, + 0x1BA at the first frame */
    u16 mark_from, restarts;    /* + 0x54: the smallest amount the speed stub marks (NO_MARK: none); new searches asked for */
    u32 servos, vetoes;         /* steps sent straight from standby; searches of the camera refused */
    u32 taken, untaken;         /* of the steps sent straight: the lens moved; it did not move at all */
    u32 direct_dead, veto_off;  /* no step straight in this recording any more (the first one was not taken); nothing refused any more */
    u32 lps;                    /* steps followed frame by frame */
    struct lagprobe lp[PROBES];
    /* working values */
    u32 holding, direct_ok, direct_block, refusals, sent_units;    /* the lens was taken for a step straight and is to be given back; one such step has moved it */
    s32 sent_position;
    u32 kept[13];                                               /* the rows as they were when the step was sent */
    u32 quiet_tick, blind_penalty, blind_search, blind_tick, blind_from;   /* the last result of any number of good areas that read "in focus"; see BLIND_MAX */
    u32 u_median, veto_since, veto_last, veto_cap;              /* the last usable value; the camera's wish to search refused since / last / for how long at most */
    u32 probe, probe_tick, probe_bad, probe_seen;               /* a search let through as a test (1: asked, 2: ended, the results after it are counted) */
    u32 ticks;                  /* frames seen in this recording, focusing or standby */
    u32 frun, frun_direction, f_last, f_before, f_tick;         /* the follow row: how many, which way, the last two values, the frame of the last */
    u32 far_on, far_since;                                      /* a large value for the far direction stands since */
    u32 usable_tick, out_since;                                 /* the last usable result; "out of focus" without a step since (0: not) */
    u32 servo_check, servo_v, servo_units, servo_direction, servo_tick, misses, veto_now, vetoes_shown;
    u32 wrun, wrun_direction, w_last, w_before, w_tick, w_first, weak_steps, weak_block;     /* the row from one or two areas; steps made on such rows; no more of them in this standby */
    u32 wrong, lp_on, lp_tick, distrust_standby;               /* steps in a row after which the value had risen; the step being followed frame by frame (index + 1) */
    u32 step_fell, big_flips, big_flip_tick, servo_seen;        /* servo_seen: the value as it read when the step was sent (the step may have been sized by less) */                    /* the last judged step made the value fall as it should; large steps against the one before, and when the last was */
    u32 flips, calm, stuck;                                     /* small steps against the one before, in a row; frames of the higher threshold left; steps that did not move the lens */
    s32 mean; u32 mean_n;                                       /* at rest: the running mean of the value, x 16, nearer positive; results in it */
    s32 servo_position;
    u32 ratio[3], ratios;                                       /* lens units x 256 a value unit was worth in the last steps */
    u32 tracking, last_count, own_count;
    u32 last_signature, result_tick;                            /* the phase result standing, and the frame it appeared in */
    u32 run, run_direction, strong_last, strong_before, strong_tick;    /* strong results in a row: how many, which way, the last two values, the frame of the last */
    u32 in_step, force, direction_before, stock_verdict, forced_now;
    u32 reverse_block, reversal_score;
    u32 moving, sent_tick, fresh_from;                          /* a fast step is under way since sent_tick (2: a step straight from standby, which may be a slow one);
                                                                   results count again from fresh_from */
    u32 last_state, travel_fast;                                /* state before; fast steps sent in this travel */
    u32 leg_tick, leg_direction;                                /* since when the travel has had its direction */
    s32 creep_left;             /* lens units of quiet two-basic-step travel still allowed after a fast step */
    u32 campaign, campaign_start, campaign_direction, campaign_forced;
    s32 campaign_position;
    u32 distrust, penalty;
    u32 recorded_frame; s32 recorded_position;
    u32 idle, idle_block, idle_penalty, restart_pending;
    s32 restart_position;
    s32 position[32];           /* the lens's own position in the last 32 frames */
    struct record r[RECORDS];
};

typedef char record_is_80_bytes[sizeof(struct record) == 80 ? 1 : -1];
typedef char mark_is_at_0x54[__builtin_offsetof(struct state, mark_from) == 0x54 ? 1 : -1];
typedef char state_fits_one_allocation[sizeof(struct state) < 0x10000 ? 1 : -1];

struct phase { const u8 *block; u32 on, valid, direction, n, lo, median, signature, agree; };

static u32 rd32(const u8 *p, u32 o) { return *(const u32 *)(p + o); }
static u16 rd16(const u8 *p, u32 o) { return *(const u16 *)(p + o); }
static u8 *rdp(const u8 *p, u32 o) { return (u8 *)*(const uptr *)(p + o); }
static void wr32(u8 *p, u32 o, u32 v) { *(u32 *)(p + o) = v; }
static void wr16(u8 *p, u32 o, u32 v) { *(u16 *)(p + o) = (u16)v; }
static u8 sat8(u32 v) { return (u8)(v > 255 ? 255 : v); }

static void write_file(const struct ctx *c, struct state *s)
{
    char name[16];
    u32 i, v, handle = 0, bytes;
    u8 *fs, *holder;

    name[0] = 'C'; name[1] = ':'; name[2] = '\\'; name[3] = 'V'; name[4] = 'Q';
    v = s->first_tick >> 8;
    for (i = 0; i < 6; i++) {
        u32 d = (v >> (20 - 4 * i)) & 15;
        name[5 + i] = (char)(d < 10 ? '0' + d : 'A' + d - 10);
    }
    name[11] = '.'; name[12] = 'B'; name[13] = 'I'; name[14] = 'N'; name[15] = 0;
    holder = c->file_holder();
    fs = holder ? rdp(holder, 0x14) : 0;
    if (!fs) return;
    {
        const u8 *vt = rdp(fs, 0);
        u32 (*open)(u8 *, const char *, u32, u32 *, u32) = (u32 (*)(u8 *, const char *, u32, u32 *, u32))rdp(vt, 0x20);
        u32 (*write)(u8 *, u32, const void *, u32, u32) = (u32 (*)(u8 *, u32, const void *, u32, u32))rdp(vt, 0x2c);
        u32 (*close)(u8 *, u32, u32) = (u32 (*)(u8 *, u32, u32))rdp(vt, 0x24);
        bytes = (u32)((u8 *)&s->r[s->records] - (u8 *)s);
        s->files++;
        if (!open(fs, name, 0, &handle, 0)) return;
        write(fs, handle, s, bytes, 0);
        close(fs, handle, 0);
    }
}

/* the phase module's result block, read where it lives: direction, reliable areas, their median value */
static void read_phase(const u8 *object, struct phase *p)
{
    u8 *zaf = rdp(object, 0x60);
    u32 i, j, vals[5];

    p->block = 0; p->on = 0; p->valid = 0; p->direction = 0; p->n = 0; p->lo = 0; p->median = 0; p->signature = 0; p->agree = 0;
    if (!zaf || !rdp(zaf, 4)) return;
    p->block = rdp(zaf, 4) + 0x10;
    if (p->block[0x1560] != 1) return;
    p->on = 1;
    {
        u32 areas = rd16(p->block, 4);
        if (areas > 5) areas = 5;
        for (i = 0; i < areas; i++) {
            u32 v = rd16(p->block, 0x18 + 2 * i), q = p->block[0x209 + 9 * i];
            p->signature = p->signature * 31 + v * 7 + q;
            if (q <= REL_OK && v != 0xffff) { vals[p->n++] = v; if (v < IN_AREA) p->lo++; }
        }
    }
    p->direction = p->block[0x11];
    p->valid = p->block[0x10] && p->direction <= 1;
    for (i = 1; i < p->n; i++)
        for (j = i; j > 0 && vals[j - 1] > vals[j]; j--) { u32 t = vals[j]; vals[j] = vals[j - 1]; vals[j - 1] = t; }
    if (p->n) p->median = vals[p->n / 2];
    p->agree = p->n >= 4 && (vals[p->n - 1] - vals[0]) * 10 <= p->median * 3;     /* the areas agree: one subject in all of them */
}

static s16 sat16(s32 v) { return (s16)(v > 32767 ? 32767 : v < -32768 ? -32768 : v); }

/* The rest of the block, for the file. */
static void read_zaf(const struct phase *p, s32 here, struct zaf *z)
{
    u32 i, j, n = 0, areas;
    s32 m[5];

    z->d14 = 0; z->mid_median = 0; z->dirs = 0; z->quality = 0;
    for (i = 0; i < 5; i++) z->mid[i] = 0;
    if (!p->block) return;
    z->d14 = (s32)rd32(p->block, 0x14) - here;
    areas = rd16(p->block, 4);
    if (areas > 5) areas = 5;
    for (i = 0; i < areas; i++) {
        const u8 *rec = p->block + 0x208 + 9 * i;
        s32 hi = (s32)rd32(p->block, 0x1038 + 4 * i), lo = (s32)rd32(p->block, 0x12cc + 4 * i);
        z->mid[i] = (hi + lo) / 2;
        if (p->block[0x162 + i]) z->dirs |= 1u << i;
        if (rec[0] == 1 && !rec[5] && !rec[6] && !rec[7]) z->quality |= 1u << i;
        if (rec[1] <= REL_OK && rd16(p->block, 0x18 + 2 * i) != 0xffff) m[n++] = z->mid[i];
    }
    for (i = 1; i < n; i++)
        for (j = i; j > 0 && m[j - 1] > m[j]; j--) { s32 t = m[j]; m[j] = m[j - 1]; m[j - 1] = t; }
    if (n) z->mid_median = m[n / 2];
}

static void fill_zframe(struct zframe *f, const struct state *s, const struct phase *p, const struct zaf *z, s32 moved)
{
    u32 i;

    f->moved = sat16(moved < 0 ? -moved : moved); f->median = (u16)p->median;
    f->flags = (u8)((p->direction & 1) | ((p->n & 7) << 1) | (p->valid ? 16 : 0) | (s->result_tick == s->ticks ? 32 : 0));
    f->age = sat8(s->ticks - s->result_tick);
    f->d14 = sat16(z->d14); f->dirs = (u8)z->dirs; f->quality = (u8)z->quality; f->pad = 0;
    for (i = 0; i < 5; i++) {
        f->mid[i] = sat16(z->mid[i]);
        f->val[i] = p->block ? rd16(p->block, 0x18 + 2 * i) : 0;
        f->rel[i] = p->block ? p->block[0x209 + 9 * i] : 0;
    }
}

/* The value from which the lens follows now. */
static u32 follow_from(const struct state *s)
{
    if (s->calm) return CALM_FROM;
    return s->servo_tick && s->ticks - s->servo_tick <= EPISODE ? FINE_FROM : FOLLOW_FROM;
}

/* Once a frame, focusing or standby: the lens's position, the end of a fast step, the row of strong results. */
static void tick(struct state *s, const struct phase *p, s32 here)
{
    s32 d;
    u32 i;

    s->ticks++;
    if (s->ticks == 1) for (i = 0; i < 32; i++) s->position[i] = here;
    d = here - s->position[(s->ticks - 1) & 31];
    if (d < 0) d = -d;
    s->position[s->ticks & 31] = here;
    if (s->moving == 2) {           /* a step straight from standby: over when the lens has moved and stands, or after 24 frames */
        if (here != s->sent_position) s->direct_ok = 1;
        if (s->ticks - s->sent_tick >= 2 && ((d == 0 && here != s->sent_position) || s->ticks - s->sent_tick > 24u)) {
            s->moving = 0; s->fresh_from = s->ticks + LAG_STOP;
            if (here != s->sent_position) s->taken++;
        }
    } else if (s->moving && s->ticks - s->sent_tick >= 2 && (d <= ARRIVED || s->ticks - s->sent_tick > 16u)) { s->moving = 0; s->fresh_from = s->ticks + LAG; }
    if (s->distrust) s->distrust--;
    if (s->direct_block) s->direct_block--;
    if (s->calm) s->calm--;
    if (!p->on) { s->run = 0; s->frun = 0; s->far_on = 0; }                /* the phase module is not running */
    if (p->signature == s->last_signature) return;
    s->last_signature = p->signature; s->result_tick = s->ticks;           /* a new phase result */
    if (s->moving || s->ticks < s->fresh_from) { s->run = 0; s->frun = 0; s->far_on = 0; s->mean_n = 0; s->wrun = 0; return; }      /* taken before the fast step had ended */
    if (p->valid && p->n && p->median < QUIET_BELOW) s->quiet_tick = s->ticks;     /* (one good area reading "in focus" is reason enough not to search) */
    if (p->valid && p->n >= AREAS) { s->wrun = 0; s->weak_steps = 0; s->blind_penalty = 0; }       /* three areas: their word counts */
    else if (p->valid && p->n) {
        if (p->median < STRONG_FROM) s->wrun = 0;
        else {
            if (s->wrun && p->direction == s->wrun_direction && s->ticks - s->w_tick <= RUN_GAP) { s->wrun++; s->w_before = s->w_last; }
            else { s->wrun = 1; s->w_before = p->median; s->w_first = s->ticks; }
            s->wrun_direction = p->direction; s->w_last = p->median; s->w_tick = s->ticks;
        }
    }
    if (p->valid && p->n >= AREAS) {                                       /* usable: is the picture in focus by it? */
        s32 signed16 = (p->direction ? -(s32)p->median : (s32)p->median) * 16;
        if (p->median >= FOLLOW_FROM) s->mean_n = 0;           /* (the mean is for what is left below the threshold) */
        else { s->mean = s->mean_n ? (s->mean * 3 + signed16) / 4 : signed16; s->mean_n++; }
        u32 here_still = p->direction == 1 && p->lo >= 2 && p->median >= 2 * IN_AREA;  /* far, but two areas still on the subject: it has not left */
        u32 out = p->median >= follow_from(s) && !here_still;
        s->usable_tick = s->ticks; s->u_median = p->median;
        if (out) {
            if (s->frun && p->direction == s->frun_direction && s->ticks - s->f_tick <= RUN_GAP) { s->frun++; s->f_before = s->f_last; }
            else { s->frun = 1; s->f_before = p->median; }
            s->frun_direction = p->direction; s->f_last = p->median; s->f_tick = s->ticks;
            if (p->median < FOLLOW_FROM) s->out_since = 0; else if (!s->out_since) s->out_since = s->ticks;
            if (p->direction == 1 && p->median >= STRONG_FROM) { if (!s->far_on) { s->far_on = 1; s->far_since = s->ticks; } }
            else s->far_on = 0;
        } else { s->frun = 0; s->far_on = 0; s->out_since = 0; }
    } else if (p->valid && p->n && p->direction != s->frun_direction) { s->frun = 0; s->far_on = 0; }
    if (p->valid && p->n >= AREAS && p->median >= STRONG_FROM) {
        if (s->run && p->direction == s->run_direction && s->ticks - s->strong_tick <= RUN_GAP) { s->run++; s->strong_before = s->strong_last; }
        else { s->run = 1; s->strong_before = p->median; }
        s->run_direction = p->direction; s->strong_last = p->median; s->strong_tick = s->ticks;
    } else if (p->valid && p->n && (p->n >= AREAS || p->direction != s->run_direction)) s->run = 0;    /* "near" from three areas, or the other direction */
}

/* What the row of strong results says is left, in value units, less the lens's movement that way since the later
   of them was taken: for certain (the smaller of the last two), and for the size of a step (the later one, at most
   1.5 x the one before).  Both 0 without such a row. */
static u32 left_by_row(const struct state *s, const struct phase *p, s32 here, u32 *for_step)
{
    u32 v, u, back = 0;
    s32 old, moved;

    *for_step = 0;
    if (s->run < AGREE || s->ticks - s->strong_tick > RECENT) return 0;
    v = s->strong_last < s->strong_before ? s->strong_last : s->strong_before;
    u = s->strong_last > s->strong_before * 3 / 2 ? s->strong_before * 3 / 2 : s->strong_last;
    if (p->valid && p->n && p->direction == s->run_direction) {     /* a later result, from fewer areas */
        if (p->median < v) v = p->median;
        if (p->median < u) u = p->median;
    }
    old = s->position[(s->strong_tick - LAG) & 31];
    moved = s->run_direction ? old - here : here - old;
    if (moved > 0) back = (u32)moved * 256 / FAST_Q8;
    *for_step = u > back ? u - back : 0;
    return v > back ? v - back : 0;
}

static void lose_trust(struct state *s)
{
    if (s->penalty < DISTRUST_FRAMES) s->penalty = DISTRUST_FRAMES;
    s->distrust = s->penalty; s->campaign = 0; s->reversal_score = 0; s->distrusts++;
    s->penalty = s->penalty * 2 > DISTRUST_MAX ? DISTRUST_MAX : s->penalty * 2;
}

static struct record *new_record(const struct ctx *c, struct state *s, u8 *timer, u32 now, const struct phase *p, s32 here)
{
    struct record *r;
    u32 i;

    if (s->records >= RECORDS) { s->dropped++; return 0; }
    r = &s->r[s->records++];
    r->t_us = now == s->first_tick ? 0 : c->elapsed(timer, s->first_tick, now, 0);   /* the camera's function gives 2^26 for no time at all */
    r->frame = s->frames;
    r->lens_real = here;
    for (i = 0; i < 5; i++) { r->value[i] = p->block ? rd16(p->block, 0x18 + 2 * i) : 0; r->reliability[i] = p->block ? p->block[0x209 + 9 * i] : 0; }
    r->median = (u16)p->median;
    r->total_direction = (u8)p->direction; r->total_valid = (u8)p->valid; r->running = p->block ? p->block[0x1560] : 0xff; r->reliable = (u8)p->n;
    r->run = sat8(s->run); r->age = sat8(s->ticks - s->result_tick);
    r->distrust = sat8(s->distrust / 4); r->campaign = sat8(s->campaign); r->reverse_block = (u8)s->reverse_block;
    return r;
}

/* The travel state's vote has given `verdict`; what the camera is to act on. */
static u32 vote(struct state *s, u32 verdict)
{
    u32 f, along;

    if (!s || s->magic != MAGIC || !s->in_step) return verdict;
    s->stock_verdict = verdict;
    f = s->force;
    if (!f || verdict == f) return verdict;
    along = f == (s->direction_before ? 2u : 1u);   /* the row's direction is the direction of travel */
    if (along) {
        if (verdict == 3) return verdict;           /* the camera goes on anyway */
    } else {                                        /* the camera is to turn round */
        if (s->reverse_block) return verdict;
        s->reverse_block = REVERSE_BLOCK;
        s->reversal_score += REVERSAL_SCORE;
        if (s->reversal_score > REVERSAL_LIMIT) { lose_trust(s); return verdict; }
        s->reversals++;
    }
    s->forced_now = f; s->forced++;
    return f;
}

/* The lens units a step takes for a value. */
static u32 units_for(u32 v, u32 direction, u32 agree)
{
    if (direction) return v * (agree ? SHARE_FAR_AGREE : SHARE_FAR_MIXED) >> 8;
    return v <= SMALL_TO ? v * SHARE_SMALL >> 8 : (SMALL_TO * SHARE_SMALL + (v - SMALL_TO) * SHARE) >> 8;
}

/* The rows of results, kept when a step straight is sent and put back when the lens did not take it. */
static void rows(struct state *s, u32 back)
{
    u32 *f[13], i;

    f[0] = &s->run; f[1] = &s->run_direction; f[2] = &s->strong_last; f[3] = &s->strong_before; f[4] = &s->strong_tick;
    f[5] = &s->frun; f[6] = &s->frun_direction; f[7] = &s->f_last; f[8] = &s->f_before; f[9] = &s->f_tick;
    f[10] = &s->far_on; f[11] = &s->far_since; f[12] = &s->out_since;
    for (i = 0; i < 13; i++) { if (back) *f[i] = s->kept[i]; else s->kept[i] = *f[i]; }
}

/* One lens move straight from standby, by the wobbling module's own lens move.  The lens takes a move only from who
   holds it (lens + 0x14; 0x5360D9A8 returns at once otherwise), and in standby nobody does: the camera takes it for
   the movie AF when a search begins (0x5362635C) and gives it back when the search ends (0x53613E2C).  So it is
   taken here the same way, and given back when the lens has stopped.  Returns 0 when it is someone else's. */
static u32 send(const struct ctx *c, struct state *s, u8 *object, u8 *w, u32 units, u32 direction, s32 here, u32 quiet)
{
    u32 travel = w[0x21];
    u8 *lens = rdp(object, 0x4c);

    if (!lens || !c->acquire(lens, 2)) {
        if (++s->refusals >= 3 && !s->direct_ok) s->direct_dead = 1;
        s->direct_block = 30;
        return 0;
    }
    s->holding = 1;
    rows(s, 0);
    s->sent_units = units; s->sent_position = here;
    w[0x21] = (u8)direction;
    s->mark_from = units >= STEP_FAST && !quiet ? (u16)units : NO_MARK;     /* (the small step for the mean at rest stays a slow one) */
    c->move(w, units, rd16(w, 0xe), 1);
    s->mark_from = NO_MARK;
    w[0x21] = (u8)travel;
    s->moving = 2; s->sent_tick = s->ticks; s->run = 0; s->frun = 0; s->far_on = 0; s->out_since = 0; s->mean_n = 0; s->wrun = 0;
    return 1;
}

/* The first usable result after a step sent straight: has the value followed the lens, and what was a value unit
   worth?  Returns marks: 4 = trust lost.
   Version 8 took a value that had risen for a step the wrong way, took the step back and left the camera alone; on the
   camera that was wrong three times out of three (a hand coming into the frame: the first value was too small, the
   next the real one; the searches that followed found the focus where the phase data had said, 2 .. 11 s later).  Now a
   value that has not fallen is a failure that only makes the next step wait for two results; two failures in a row,
   or large steps to, fro and to again, lose the trust. */
static u32 judge_step(struct state *s, const struct phase *p, s32 here)
{
    s32 d = here - s->servo_position;
    u32 moved = (u32)(d < 0 ? -d : d), worth = 0;

    s->servo_check = 0;
    if (moved * 2 < s->servo_units) {                          /* the lens went less than half way (the end of its range): nothing to say about
                                                                   the phase data; after STUCK such steps in a row, no step straight for a while */
        if (++s->stuck >= STUCK) { s->stuck = 0; s->direct_block = DIRECT_BLOCK; }
        return 0;
    }
    s->stuck = 0;
    if (moved < JUDGE_FROM) { s->step_fell = 1; return 0; }    /* (a small step is within what a moving subject does meanwhile) */
    if (p->direction == s->servo_direction) {
        if (p->median < s->servo_seen) worth = moved * 256 / (s->servo_seen - p->median);   /* (against the value as it read when the step was sent) */
        s->step_fell = worth && worth <= FELL_Q8;
        if (p->median >= s->servo_seen + 2 * moved) {           /* risen by two units per lens unit: as a step the wrong way would make it */
            if (++s->wrong >= WRONG) { s->wrong = 0; s->misses = 0; lose_trust(s); s->distrust_standby = 1; return 4; }
        } else s->wrong = 0;
        if (!worth || worth > 512) {                            /* not fallen by half a unit per lens unit: the subject goes on moving, or the value is no use */
            if (p->median < STRONG_FROM) s->misses = 0;         /* (a small value that stays is a subject followed at its own pace: that is what the steps are for) */
            else if (++s->misses >= NOFALL) { s->misses = 0; s->direct_block = DIRECT_BLOCK; }
            return 0;
        }
    } else {                                                    /* the focus is behind the lens now: passed, or the subject is another */
        worth = moved * 256 / (s->servo_seen + p->median);
        s->step_fell = p->median < FOLLOW_FROM || p->median * 2 <= s->servo_seen;
        s->wrong = 0;
        if (p->median >= 2 * FOLLOW_FROM && p->median * 4 >= s->servo_seen * 3) {      /* as far out as before, on the other side: Sony takes a lens that does not
                                                                                          go one way for a sign that the phase data is no use */
            if (s->big_flips && s->ticks - s->big_flip_tick > FLIP_FRAMES) s->big_flips = 0;
            s->big_flip_tick = s->ticks;
            if (++s->big_flips >= FLIPS) { s->big_flips = 0; lose_trust(s); s->distrust_standby = 1; return 4; }
        }
    }
    s->misses = 0;
    if (s->step_fell) s->penalty = 0;
    if (worth) {
        if (worth < 40) worth = 40;
        if (worth > 200) worth = 200;
        s->ratio[s->ratios % 3] = worth; s->ratios++;
    }
    return 0;
}

/* Standby, the lens at rest, a follow row: the lens goes straight there.  Returns the lens units sent (0: none). */
static u32 follow(const struct ctx *c, struct state *s, u8 *object, const struct phase *p, s32 here, u32 *sized_by)
{
    u8 *w = rdp(object, 0x15c8);
    u32 v, units, direction, going;

    *sized_by = 0;
    if (!w || s->distrust || s->direct_dead || s->direct_block || s->moving || s->ticks < s->fresh_from || s->idle <= SERVO_WAIT || object[0x85cb]) return 0;   /* (+ 0x85CB: a search has been asked for) */
    if ((!s->frun || s->ticks - s->f_tick > RECENT) && s->wrun >= WEAK_AGREE && s->ticks - s->w_tick <= RECENT && s->ticks - s->w_first >= FAR_HOLD
        && !s->weak_block && s->weak_steps < WEAK_STEPS) {      /* no row from three areas, but one or two keep saying the same */
        direction = s->wrun_direction;
        v = s->w_last < s->w_before ? s->w_last : s->w_before;
        units = units_for(v, direction, 0) * 3 / 4;             /* (Canon's second grade of reliability goes 0.7 .. 0.8 of the way) */
        if (units > FAST_MAX) units = FAST_MAX;
        if (s->servo_tick && direction != s->servo_direction && s->ticks - s->servo_tick < LOCK_SHORT) return 0;
        if (s->weak_steps && direction != s->servo_direction) { s->weak_block = 1; return 0; }     /* there and back on such data: the camera's turn */
        if (!send(c, s, object, w, units, direction, here, 0)) return 0;
        s->servo_check = 0; s->servo_v = v; s->servo_seen = v; s->servo_units = units; s->servo_direction = direction; s->servo_tick = s->ticks; s->servo_position = here;
        s->step_fell = 0; s->misses = 0; s->weak_steps++; s->servos++;
        s->usable_tick = s->ticks;                              /* (the camera's own search waits for what the areas say at the new place) */
        *sized_by = v;
        return units;
    }
    if (!s->frun || s->ticks - s->f_tick > RECENT) {            /* no row: the lens at rest, and the mean of the last results still to one side? */
        u32 off = (u32)(s->mean < 0 ? -s->mean : s->mean) / 16;
        if (s->frun || s->calm || s->mean_n < TRIM_RESULTS || off < TRIM_FROM || s->ticks - s->result_tick > RECENT) return 0;
        direction = s->mean < 0;
        units = units_for(off, direction, 0);
        if (!units || !s->direct_ok) return 0;                             /* (the first step straight of a recording is one that shows whether the lens takes it) */
        if (s->servo_tick && direction != s->servo_direction && s->ticks - s->servo_tick < LOCK_LONG) return 0;
        if (s->servo_tick && direction != s->servo_direction && s->ticks - s->servo_tick <= 120) { if (++s->flips >= 2) { s->flips = 0; s->calm = CALM; } } else s->flips = 0;
        if (!send(c, s, object, w, units, direction, here, 1)) return 0;
        s->servo_direction = direction; s->servo_tick = s->ticks; s->servo_check = 0; s->mean_n = 0; s->servos++;
        *sized_by = off;
        return units;
    }
    direction = s->frun_direction;
    v = s->frun < AGREE ? s->f_last : s->f_last > s->f_before * 2 ? s->f_before * 2 : s->f_last;      /* (up to version 11: at most 1.5 x the one before, which
                                                                                                          sized 10 of 91 steps by less than the value read, a subject
                                                                                                          still coming in, and they covered less of the way) */
    /* going on: a step that way was sent just before, the value fell for it as it should, and is not far above what it
       was then (the same approach, or the same subject moving); anything else is a subject of its own and needs its own
       row, and the hold if it is far.  (Camera, version 8: a far value of 395, 78 units sent, the next value 280 instead of
       100 or less, 55 more units sent on that one result, and the lens was 65 units past the focus.) */
    going = s->servo_tick && s->servo_direction == direction && s->ticks - s->servo_tick <= EPISODE && v <= s->servo_v * 3 / 2 && s->step_fell;
    if (going && v > s->servo_v) v = s->servo_v;               /* never more than before that step */
    if (p->valid && p->n && p->direction == direction && p->median < v) v = p->median;     /* a later result, from fewer areas */
    if (s->frun < AGREE && !(going && v >= FOLLOW_FROM && s->f_tick >= s->fresh_from)) return 0;       /* (going on, one result of FOLLOW_FROM is enough) */
    /* only on the newest result: the row's last one must be the one standing now.  (Camera, version 12: 111 units on a row from the end of
       a search while the result standing came from one area; 87 units while no area was valid any more.) */
    if (s->f_tick != s->result_tick || !p->valid || p->n < AREAS || p->direction != direction) return 0;
    /* Canon: after a step, none back the other way for a while: 0.3 s where the defocus is large, 1 s where it is small */
    if (s->servo_tick && direction != s->servo_direction && s->ticks - s->servo_tick < (v >= LOCK_BIG ? LOCK_SHORT : LOCK_LONG)) return 0;
    if (v < (going ? FINE_FROM : s->calm ? CALM_FROM : FOLLOW_FROM)) return 0;
    if (direction == 1 && v >= STRONG_FROM && !going && s->ticks - s->far_since < FAR_HOLD) return 0;   /* a far subject: not at once */
    units = units_for(v, direction, p->valid && p->agree && p->direction == direction) * GAIN_Q8 >> 8;
    if (units > FAST_MAX) units = FAST_MAX;
    if (STEP_CAP && units > STEP_CAP) units = STEP_CAP;
    if (!units || (units < DEAD_UNITS && !s->direct_ok)) return 0;
    if (units < FAST_MIN && s->servo_tick && direction != s->servo_direction && s->ticks - s->servo_tick <= 60) {
        if (++s->flips >= 2) { s->flips = 0; s->calm = CALM; }     /* to, fro and to again in small steps: the data is too rough here */
    } else s->flips = 0;
    if (!going && (!s->servo_tick || s->ticks - s->servo_tick > EPISODE)) { s->misses = 0; s->wrong = 0; }      /* a new way: failures count within one */
    if (!send(c, s, object, w, units, direction, here, 0)) return 0;
    s->servo_seen = p->valid && p->n >= AREAS && p->direction == direction && p->median > v ? p->median : v;
    s->servo_check = 1; s->servo_v = v; s->servo_units = units; s->servo_direction = direction; s->servo_tick = s->ticks; s->servo_position = here;
    s->step_fell = units < JUDGE_FROM;      /* (a larger step has to show it) */
    s->servos++;
    if (units >= PROBE_FROM && s->lps < PROBES && !s->lp_on) {             /* followed frame by frame, for the file */
        struct lagprobe *q = &s->lp[s->lps++];
        q->tick = s->ticks; q->units = (u16)units; q->by = (u16)v; q->direction = (u8)direction;
        s->lp_on = s->lps; s->lp_tick = s->ticks;
    }
    *sized_by = v;
    return units;
}

/* The camera's own decision is about to ask for a new search: may it? */
static u32 may_search(const struct ctx *c, struct state *s, const u8 *object)
{
    u32 direct;

    if (!s || s->magic != MAGIC || !(c->flags & 16) || !object || !object[0x6548] || !s->frames || s->distrust || s->veto_off) return 1;
    if (s->ticks > STALL_TICKS && s->result_tick < STALL_RESULT) return 1;   /* no phase data in this recording: the camera's own search */
    direct = !s->direct_dead && !s->direct_block;
    if (!s->moving && s->ticks >= s->fresh_from
        && !(direct && s->servo_tick && s->ticks - s->servo_tick < LOCK_LONG && s->u_median < LOCK_BIG && s->ticks - s->usable_tick <= BLIND)) {
                                                               /* (a step under way, or just over: wait for what the phase data says; and no search for the
                                                                  small defocus the module itself is leaving alone for a second after a step) */
        if (s->ticks - (s->usable_tick > s->blind_from ? s->usable_tick : s->blind_from) > BLIND + s->blind_penalty && s->ticks - s->quiet_tick > BLIND   /* no usable phase data for a while (since the last such search ended), none that reads "in focus" from
                                                                                                          any area (and no row from one or two areas on its way to a step) */
            && !(s->wrun >= 2 && s->ticks - s->w_tick <= RECENT && !s->weak_block && s->weak_steps < WEAK_STEPS)) {
            s->blind_search = 1; s->blind_tick = s->ticks;
            return 1;
        }
        if (s->ticks - s->usable_tick > BLIND && s->ticks - s->quiet_tick > BLIND) { s->vetoes++; s->veto_now = 1; return 0; }     /* (waiting out the penalty) */
        if (direct ? s->out_since && s->ticks - s->out_since > OUT_LIMIT       /* out of focus by it, and no step has come of it */
                   : s->u_median >= QUIET_BELOW) return 1;                     /* out of focus by it, and no step straight to be had */
        /* in focus by it, or a step straight will see to it: refused, but not for ever */
        if (!s->veto_since || s->ticks - s->veto_last > VETO_GAP) s->veto_since = s->ticks;
        s->veto_last = s->ticks;
        if (s->ticks - s->veto_since > (s->veto_cap ? s->veto_cap : VETO_CAP)) {
            s->veto_since = 0; s->probe = 1;
            return 1;
        }
    }
    s->vetoes++; s->veto_now = 1;
    return 0;
}

/* Ask for a new search the way the camera's own decision (0x53614584) does, under its conditions.  Returns marks:
   32 = asked, 64 = not possible now. */
static u32 request(const struct ctx *c, struct state *s, u8 *object, s32 here)
{
    u8 *hi = object + 0x10000, *parent = rdp(object, 0x48), *lens_object = rdp(object, 0x50);
    u32 marks = 64;

    if (parent && lens_object && object[0x85ca] && !object[0x85cb] && !object[0x85cc] && !object[0x85e5] && !object[0x85c9] && !hi[0xce4]
        && c->lens_state(lens_object, 0) != 1) {
        u32 r = c->restart(parent, 2, 2, 0);
        object[0x85cb] = (u8)r;
        if (r) { hi[0xcb0] = 1; s->restarts++; s->restart_pending = 1; s->restart_position = here; marks = 32; }
    }
    s->idle_block = RESTART_RETRY;
    return marks;
}

/* A standby frame: the camera's monitor has run and has not started a search. */
static void standby(const struct ctx *c, struct state *s, u8 *object, u32 scene)
{
    struct phase p;
    struct zaf z;
    u8 *holder, *timer, *lens;
    u8 *hi = object + 0x10000;
    u32 now, size, marks = 0, entered, sent = 0, sized_by = 0;
    s32 here;

    if (!s || s->magic != MAGIC || !(c->flags & 24) || !object[0x6548] || !s->frames) return;  /* while recording, after the first focusing frame */
    holder = c->timer_holder();
    timer = holder ? rdp(holder, 0xc) : 0;
    lens = rdp(object, 0x4c);
    if (!timer || !lens) return;
    here = c->lens_position(lens);
    read_phase(object, &p);
    read_zaf(&p, here, &z);
    tick(s, &p, here);
    entered = !s->idle;
    s->idle++;
    if (entered) {
        if (s->restart_pending) {   /* a search this module asked for has ended: did the lens go anywhere? */
            s32 d = here - s->restart_position;
            if (d < 0) d = -d;
            if (d >= RESTART_PROOF) s->idle_penalty = 0;
            else {
                s->idle_penalty = s->idle_penalty * 2 < RESTART_PENALTY ? RESTART_PENALTY : s->idle_penalty * 2;
                if (s->idle_penalty > DISTRUST_MAX) s->idle_penalty = DISTRUST_MAX;
            }
            s->restart_pending = 0;
        }
        s->idle_block = s->idle_penalty > RESTART_WAIT ? s->idle_penalty : RESTART_WAIT;
        s->out_since = 0; s->servo_check = 0; s->veto_since = 0; s->weak_block = 0; s->weak_steps = 0; s->wrun = 0;
        if (c->flags & 16) {        /* the rows begin anew: the results of the search's last frames were taken while the lens moved */
            s->run = 0; s->frun = 0; s->far_on = 0; s->mean_n = 0;
            if (s->fresh_from < s->ticks + 6) s->fresh_from = s->ticks + 6;   /* (the lens stopped some frames before the search ended; a result is 3 .. 7 frames behind) */
        }
        if (s->blind_search) {      /* a search let through for want of phase data has ended: with data, or still without? */
            if (s->usable_tick > s->blind_tick) s->blind_penalty = 0;
            else { s->blind_penalty = s->blind_penalty ? s->blind_penalty * 2 : 120; if (s->blind_penalty > BLIND_MAX) s->blind_penalty = BLIND_MAX; }
            s->blind_search = 0; s->blind_from = s->ticks;
        }
        if (s->probe == 1) { s->probe = 2; s->probe_tick = s->ticks; s->probe_bad = 0; s->probe_seen = 0; }
        if (s->distrust_standby) { s->distrust = 0; s->distrust_standby = 0; }     /* Sony: the contrast search has had its turn, the phase data counts again */
    }
    if (s->lp_on) {                 /* the frames after a large step, for the file */
        u32 k = s->ticks - s->lp_tick;
        if (k >= 1 && k <= PROBE_FRAMES) fill_zframe(&s->lp[s->lp_on - 1].f[k - 1], s, &p, &z, here - s->sent_position);
        if (k >= PROBE_FRAMES || s->sent_tick != s->lp_tick) s->lp_on = 0;
    }
    if (s->probe == 2) {            /* a search let through although the phase data said "in focus" has ended on the contrast peak: what does the phase data say there? */
        if (s->result_tick == s->ticks && p.valid && p.n >= AREAS) {
            s->probe_seen++;
            if (p.median >= QUIET_BELOW) s->probe_bad++;
        }
        if (s->probe_seen >= PROBE_RESULTS || s->ticks - s->probe_tick > PROBE_WAIT) {
            if (s->probe_seen >= PROBE_RESULTS && s->probe_bad == s->probe_seen) s->veto_off = 1;
            else if (s->probe_seen) { s->veto_cap = (s->veto_cap ? s->veto_cap : VETO_CAP) * 2; if (s->veto_cap > DISTRUST_MAX) s->veto_cap = DISTRUST_MAX; }
            s->probe = 0;
        }
    }
    if (c->flags & 16) {            /* the focus is kept from here: a step straight there where the lens takes one, else a search asked for at once */
        u8 *w = rdp(object, 0x15c8);
        u32 direct;
        /* the lens has not moved at all DEAD_FRAMES frames after a step was sent (a taken one shows in the next frame): it was
           not taken.  Nothing was learnt about the phase data, so the rows stand as they were.  If no step straight has ever
           moved the lens in this recording there are none any more; else none for a while after STUCK in a row. */
        if (s->moving == 2 && s->sent_units >= DEAD_UNITS && s->ticks - s->sent_tick >= DEAD_FRAMES && here == s->sent_position) {
            s->moving = 0; s->fresh_from = s->ticks; s->servo_check = 0; s->servo_tick = 0; s->untaken++;
            rows(s, 1);
            if (w) w[9] = 1;
            if (!s->direct_ok) s->direct_dead = 1;
            else if (++s->stuck >= STUCK) { s->stuck = 0; s->direct_block = DIRECT_BLOCK; }
            marks |= 1;
        }
        if (s->holding && !s->moving) {     /* the lens goes back to nobody, as after a search */
            if (rd32(lens, 0x14) != 2 || c->release(lens, 2)) s->holding = 0;
        }
        /* the lens tells the camera when a move has ended (0x53612554 sets the wobbling module's "arrived" flag); should that
           not have come eight frames after the lens stopped, the flag is set here, so that the next search does not wait for it */
        if (w && !w[9] && s->servo_tick && !s->moving && s->ticks >= s->fresh_from && s->sent_tick == s->servo_tick) { w[9] = 1; marks |= 8; }
        if (s->servo_check && s->ticks - s->servo_tick > 60) s->servo_check = 0;
        if (s->servo_check && !s->moving && s->result_tick >= s->fresh_from && s->ticks >= s->fresh_from && p.valid && p.n >= AREAS) {
            marks |= judge_step(s, &p, here);
        }
        sent = follow(c, s, object, &p, here, &sized_by);
        if (sent) marks |= 128;
        /* no step straight to be had (the lens takes none, or the trust is gone): a search is asked for, as the camera's own
           decision does it.  Without trust: on RESTART_AGREE strong results, as in version 6.  With it: on AGREE results of
           ASK_FROM, a far subject after FAR_HOLD frames. */
        direct = !s->direct_dead && !s->direct_block;
        if (s->idle_block) s->idle_block--;
        else if (!sent && !s->moving && !s->holding && s->ticks >= s->fresh_from) {
            u32 want = 0;
            if (s->distrust) want = s->run >= RESTART_AGREE && s->ticks - s->strong_tick <= RESTART_FRESH;
            else if (!direct && s->frun >= AGREE && s->ticks - s->f_tick <= RESTART_FRESH) {
                u32 v = s->f_last < s->f_before ? s->f_last : s->f_before;
                want = v >= ASK_FROM && !(s->frun_direction == 1 && v >= STRONG_FROM && s->ticks - s->far_since < FAR_HOLD);
            }
            if (want) marks |= request(c, s, object, here);
        }
        if (s->veto_now) { s->veto_now = 0; marks |= 16; }
    } else {
        if (s->idle_block) s->idle_block--;
        else if (!s->distrust && s->run >= RESTART_AGREE && s->ticks - s->strong_tick <= RESTART_FRESH) marks |= request(c, s, object, here);
    }
    if (s->lp_on && s->lp_tick == s->ticks) fill_zframe(&s->lp[s->lp_on - 1].pre, s, &p, &z, 0);       /* the frame a followed step was sent in */
    if ((c->flags & 4) && ((marks & ~16u) || (s->idle & 7) == 1)) {
        struct record *r;
        now = c->tick(timer);
        r = new_record(c, s, timer, now, &p, here);
        if (r) {
            r->lens = (s32)rd32(lens, 0x14) | (s32)(s->holding << 8) | (s32)(s->direct_dead << 9) | (s32)(s->veto_off << 10) | (s32)((s->direct_block ? 1u : 0u) << 11);   /* who holds the lens (2: the movie AF) */
            r->count = (s32)s->idle; r->own_count = (s16)s->frun; r->count_before = (s16)p.lo;
            r->base = (u16)sat16(z.d14); r->step = (u16)sent;      /* (version 12: base, lens_speed and last_amount carry what else the block says) */ r->cap = (u16)(s->vetoes - s->vetoes_shown); r->wanted = (u16)(sent && sized_by ? sent * 256 / sized_by : 0);
            r->median_used = (u16)(sent ? sized_by : left_by_row(s, &p, here, &size)); r->steps_in_climb = 0;
            r->lens_speed = (u16)sat16(z.mid_median); r->last_amount = (u16)(z.dirs | z.quality << 8);
            r->moved = (s16)(s->ratios ? s->ratio[(s->ratios - 1) % 3] : 0);
            r->phase_of_step = STANDBY; r->verdict = object[0x85ca]; r->direction = (u8)scene; r->result = object[0x85cb];
            r->stock_verdict = 0xff; r->forced = 0;
            r->motor = hi[0xca6]; r->quiet = hi[0xba8]; r->ready = object[0x85cc]; r->returning = object[0x85e5];
            r->settle = s->moving ? 255 : sat8(s->ticks < s->fresh_from ? s->fresh_from - s->ticks : 0);
            r->marks = (u8)(marks | (s->vetoes != s->vetoes_shown ? 16 : 0));
            s->vetoes_shown = s->vetoes;
        }
    }
}

u32 vafquick(const struct ctx *c, u32 which, u8 *object, u32 value)
{
    struct state *s = (struct state *)*c->slot;
    struct phase p;
    u8 *holder, *timer, *w, *lens, *lco;
    u32 now, i, left, size, result, e5, wdir, base, count, before, final, wanted = 0, fast = 0, cap, raised, climb, ready, sent, settling, marks = 0;
    s32 here, moved = 0, apart;

    if (which == 2) return vote(s, (u32)(uptr)object);
    if (which == 3) { standby(c, s, object, value); return 0; }
    if (which == 4) return may_search(c, s, object);
    if (which == 1) { /* recording ended */
        if (s && s->magic == MAGIC) {
            if ((c->flags & 4) && s->records) { s->stops++; write_file(c, s); }
            s->records = 0; s->dropped = 0; s->frames = 0; s->forced = 0; s->reversals = 0; s->sized = 0; s->distrusts = 0; s->restarts = 0;
            s->servos = 0; s->vetoes = 0; s->vetoes_shown = 0; s->frun = 0; s->far_on = 0; s->usable_tick = 0; s->out_since = 0;
            s->servo_check = 0; s->servo_tick = 0; s->misses = 0; s->veto_now = 0; s->ratios = 0; s->flips = 0; s->calm = 0; s->mean_n = 0; s->stuck = 0;
            s->step_fell = 0; s->big_flips = 0; s->wrun = 0; s->weak_steps = 0; s->weak_block = 0; s->taken = 0; s->untaken = 0; s->direct_dead = 0; s->veto_off = 0; s->holding = 0; s->direct_ok = 0; s->direct_block = 0; s->refusals = 0;
            s->u_median = 0; s->veto_since = 0; s->veto_last = 0; s->veto_cap = 0; s->probe = 0; s->probe_seen = 0; s->probe_bad = 0;
            s->lps = 0; s->lp_on = 0; s->wrong = 0; s->distrust_standby = 0; s->quiet_tick = 0; s->blind_penalty = 0; s->blind_search = 0; s->blind_from = 0;
            s->mark_from = NO_MARK;
            s->ticks = 0; s->tracking = 0; s->last_signature = 0; s->result_tick = 0; s->run = 0; s->strong_tick = 0;
            s->in_step = 0; s->force = 0; s->reverse_block = 0; s->reversal_score = 0;
            s->moving = 0; s->sent_tick = 0; s->fresh_from = 0; s->creep_left = 0; s->last_state = 0; s->travel_fast = 0; s->leg_tick = 0; s->campaign = 0; s->distrust = 0; s->penalty = 0;
            s->idle = 0; s->idle_block = 0; s->idle_penalty = 0; s->restart_pending = 0;
        }
        return value;
    }
    if (which != 0 || !object) return value;
    w = rdp(object, 0x15c8);
    holder = c->timer_holder();
    timer = holder ? rdp(holder, 0xc) : 0;
    if (!w || !timer) return c->step(object, 1);
    if (!s) {
        if (!*c->slot) {
            s = (struct state *)c->alloc(sizeof *s);
            if (s) {
                u32 *z = (u32 *)s, k = (u32)((u8 *)&s->r[0] - (u8 *)s) / 4;
                while (k--) *z++ = 0;
                s->version = VERSION; s->record_bytes = sizeof(struct record); s->header_bytes = (u32)((u8 *)&s->r[0] - (u8 *)s);
                s->mark_from = NO_MARK;
                s->magic = MAGIC;
                *c->slot = (uptr)s;
            }
        }
        if (!s) return c->step(object, 1);
    }
    if (s->magic != MAGIC) return c->step(object, 1);
    lens = rdp(object, 0x4c);
    lco = lens ? rdp(lens, 0xc) : 0;
    now = c->tick(timer);
    if (!s->frames) {
        s->first_tick = now;
        s->frame_rate_bits = rd32(object, 0x651c);
        for (i = 0; i < 5; i++) s->lens_speed[i] = rd16(object, 0x6576 + 2 * i);
        s->lens_unit = rd16(w, 0x3c);
        s->aperture_bits = rd32(w, 0x30);
        s->flags = c->flags;
        if (lco) { s->lens_index = lco[0x78]; s->lens_quiet = lco[0x371]; s->motor_ordinary = lco[0x1ba]; }
    }
    s->frames++;
    s->idle = 0;
    s->holding = 0;             /* a search: the camera has taken the lens itself and gives it back at the end */
    if (s->moving == 2) { s->moving = 0; s->fresh_from = s->ticks + 1 + LAG; }
    s->servo_check = 0;
    here = lens ? c->lens_position(lens) : 0;
    if (s->frames == 1) { s->recorded_position = here; s->recorded_frame = 0; }
    read_phase(object, &p);
    tick(s, &p, here);
    s->mean_n = 0;              /* (the mean at rest is for standby) */
    if (s->reverse_block) s->reverse_block--;
    if (s->reversal_score) s->reversal_score--;

    e5 = w[0xe5]; wdir = w[0x21]; base = rd16(w, 0x10); count = rd32(w, 0xc78);
    before = count;
    climb = rd16(w, 0xcb0); ready = w[9];
    /* what the camera's own count would be without this module */
    if (!s->tracking || count != s->last_count) s->own_count = count;
    s->tracking = 1;
    if (e5 == 5 && s->last_state != 5) s->travel_fast = 0;     /* a new travel */
    if (e5 == 5 && (s->last_state != 5 || wdir != s->leg_direction)) { s->leg_tick = s->ticks; s->leg_direction = wdir; }
    s->last_state = e5;

    left = left_by_row(s, &p, here, &size);
    if (s->distrust || e5 != 5) left = size = 0;
    settling = s->moving || s->ticks < s->fresh_from;
    if (p.valid && s->ticks - s->result_tick <= STALE) {       /* what the lens has moved the phase way since the result standing was taken (its own position counts the other way round) */
        s32 old = s->position[(s->result_tick - LAG) & 31];
        moved = p.direction ? old - here : here - old;
    }

    /* 2. direction, for the vote inside this frame's step */
    s->force = 0; s->forced_now = 0; s->stock_verdict = 0xff; s->direction_before = wdir;
    if ((c->flags & 2) && left >= STRONG_FROM) {
        if (s->run_direction == wdir) s->force = wdir ? 2 : 1;                                             /* not to stop, not to turn */
        else if (s->ticks - s->leg_tick <= YOUNG || (s->run >= OLD_AGREE && left >= OLD_FROM)) s->force = s->run_direction ? 2 : 1;    /* to turn round */
    }

    /* 1. step size */
    final = s->own_count;
    if ((c->flags & 1) && !s->distrust && base && e5 == 5 && (s32)count >= 0) {
        u32 units = size * FAST_Q8 >> 8;
        if (s->run_direction == wdir && units >= (s->travel_fast ? FAST_AGAIN : FAST_MIN)) {
            if (!climb) marks |= 16;                            /* the camera sets its count anew on this step: one step later */
            else {
                if (units > FAST_MAX) units = FAST_MAX;
                final = units / base;
                if (final) final--;
                fast = (final + 1) * base >= FAST_MIN;
                wanted = final + 1;
            }
        } else if (p.valid && p.n >= AREAS && s->ticks - s->result_tick <= STALE) {
            if (p.direction == wdir) {
                if (settling || moved >= FAST_SEEN) final = s->creep_left >= (s32)(2 * base) ? QUIET_COUNT : 0;    /* the value does not show the fast step yet */
                else final = (p.median * FAST_Q8 >> 8) >= QUIET_FROM ? QUIET_COUNT : 0;                                 /* by the value as it is: old, but the lens only creeps */
                wanted = final + 1;
            } else if (p.median < STRONG_FROM) { final = 0; wanted = 1; }   /* the focus is just behind: the smallest step */
        }
    }
    if (final != count) wr32(w, 0xc78, final);
    cap = raised = rd16(w, 0x1e);
    if (wanted && (fast || cap < (final + 1) * base)) raised = (final + 1) * base;     /* the camera's limit: room for a quiet step, the amount itself for the fast one
                                                                                           (the camera's own ramp may add a basic step to its count) */
    if (raised != cap) wr16(w, 0x1e, raised);
    s->mark_from = fast ? (u16)((final + 1) * base) : NO_MARK;
    if (fast) marks |= 8;

    s->in_step = 1;
    result = c->step(object, 1);
    s->in_step = 0;

    s->mark_from = NO_MARK;
    if (raised != cap && rd16(w, 0x1e) == raised) wr16(w, 0x1e, cap);  /* the camera's own limit stays what it was */
    count = rd32(w, 0xc78);
    if (count == final + 1) s->own_count++;         /* the camera went up one */
    else if (count != final) s->own_count = count;  /* the camera set it anew */
    if (base && (s32)s->own_count > 0 && s->own_count > cap / base) s->own_count = cap / base;
    s->last_count = count;

    /* a travel step was sent in this frame: the camera counted it, or the "lens has arrived" flag went down */
    sent = w[0xe5] == 5 && (rd16(w, 0xcb0) != climb || (ready && !w[9]));
    if (sent && fast && w[0x21] == wdir && rd16(w, 0x1a) >= (final + 1) * base) {  /* the fast one: the amount named went out (a smaller step is not marked) */
        s->moving = 1; s->sent_tick = s->ticks; s->run = 0;
        s->creep_left = (s32)(rd16(w, 0x1a) * 5 / 16);         /* (0.37 - 0.28) / 0.28 of the step is left at the usual ratio */
        s->travel_fast++;
        s->sized++;
        marks |= 1;
    } else if (sent && wanted && s->creep_left > 0) s->creep_left -= (s32)rd16(w, 0x1a);

    /* 3. trust: once this module steers, the phase value has to follow the lens */
    if (s->campaign) {
        s32 seen = s->position[(s->ticks - PROOF_LAG) & 31];   /* how far the value can show the lens by now */
        s32 toward = s->campaign_direction ? s->campaign_position - seen : seen - s->campaign_position;
        s->campaign++;
        if (s->forced_now) s->campaign_forced = 1;
        if (!p.valid || p.direction != s->campaign_direction) s->campaign = 0;      /* the phase result turned or went */
        else if (toward >= PROOF_UNITS) {
            if (p.median + (u32)toward > s->campaign_start) { lose_trust(s); marks |= 4; }  /* the lens went, the value did not follow */
            else { s->campaign = 0; s->penalty = 0; }                               /* it followed */
        } else if (p.median * 10 <= s->campaign_start * 6) s->campaign = 0;         /* 40 % closer already (the subject may have moved) */
        else if (s->campaign >= STALL_FRAMES) {
            if (s->campaign_forced) { lose_trust(s); marks |= 4; }                  /* votes replaced, and the lens gets nowhere */
            else s->campaign = 0;
        }
    }
    if (!s->campaign && !s->distrust && left >= CAMPAIGN_FROM && ((marks & 1) || s->forced_now)) {
        s->campaign = 1; s->campaign_start = s->strong_last < s->strong_before ? s->strong_last : s->strong_before;
        s->campaign_direction = s->run_direction; s->campaign_position = s->position[(s->ticks - 1) & 31];
        s->campaign_forced = s->forced_now ? 1 : 0;
        marks |= 2;
    }

    /* the recording: every frame in which the camera voted or sent a step or this module did something, every frame
       the lens has gone 8 units since the last record, and every fourth frame otherwise */
    apart = here - s->recorded_position;
    if (apart < 0) apart = -apart;
    if ((c->flags & 4) && (s->stock_verdict != 0xff || sent || (marks & 23) || apart >= 8 || s->frames - s->recorded_frame >= 4)) {
        struct record *r = new_record(c, s, timer, now, &p, here);
        s->recorded_frame = s->frames; s->recorded_position = here;
        if (r) {
            r->lens = (s32)rd32(w, 0x134);
            r->count = (s32)count;
            r->own_count = (s16)s->own_count; r->count_before = (s16)before;
            r->base = rd16(w, 0x10); r->step = rd16(w, 0x1a); r->cap = rd16(w, 0x1e); r->wanted = (u16)wanted;
            r->median_used = (u16)left; r->steps_in_climb = (u16)climb;
            r->lens_speed = lco ? rd16(lco, 0x1e2) : 0; r->last_amount = lens ? rd16(lens, 0x18) : 0;
            r->moved = (s16)(moved > 32767 ? 32767 : moved < -32768 ? -32768 : moved);
            r->phase_of_step = w[0xe5]; r->verdict = w[0xe6]; r->direction = w[0x21]; r->result = (u8)result;
            r->stock_verdict = (u8)s->stock_verdict; r->forced = (u8)s->forced_now;
            r->motor = lco ? lco[0x1e0] : 0; r->quiet = lco ? lco[0x371] : 0; r->ready = w[9]; r->returning = w[0x20];
            r->settle = s->moving ? 255 : sat8(s->ticks < s->fresh_from ? s->fresh_from - s->ticks : 0); r->marks = (u8)marks;
        }
    }
    return result;
}
