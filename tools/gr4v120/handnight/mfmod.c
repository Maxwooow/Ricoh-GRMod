/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR Mod: Handheld Night, the multi-frame noise reduction for the Ricoh GR IV, firmware 1.20 (1.21: the generated copy).
 * The merge itself is c/mf_core.c (bit-exact with ref.py v10, vmax = 2^bits - 1); this file is the camera
 * side: grouping the frames of a burst, memory, timing, the log file, the menu switch and the "4 frames per press" rule.
 * Reverse engineering behind every address: the research notes (T5, T7b, "T7d settings", "T7d stopping a burst").
 *
 * Entry mfmod(ctx, which, a, b, e):
 *   which 0, a = recipe, b = module id: called by the back end (BEStillImageProcess task) right after the stock
 *            SetupModuleConfig of every module of every recipe (0x53745688).  Only module 9 (RAW_CODEC) of a normal
 *            still (SI+0xB11 == 0, sequence type 0/1/5/6/16) does anything, and only with the switch on, in
 *            continuous drive, with a DNG:
 *              frames 1..3 of a group (mf13, "hold instead of copy"): no copy.  The frame's own Bayer buffer is registered
 *                in a hold slot (its allocation address [recipe+0x358], the pixel pointer [recipe+0x60], a canary: 32
 *                pixels and a checksum of 4 rows), if IMAGE2's largest free block still holds one Bayer buffer (the next
 *                shot's allocation 0x53742E7C can be served at that moment).  The stock flow is left alone: every free
 *                of a pool block (the entry of the variable pool's free method 0x53905DB0, which Free 0x538F666C and the
 *                direct pool->vt[0xC] callers reach) goes through a hook (handnight.ts) that, for a held address,
 *                switches the slot HELD -> RELEASED atomically and skips the free (the stock bookkeeping goes on as if it
 *                was freed), or, called from the relocation (0x5374AAE4), HELD -> DROPPED and lets the free through (the
 *                stock moved the data: our pointer is stale, that frame is no alternate).  Every way out of the group resolves each slot once (hold_resolve):
 *                RELEASED -> freed here with the stock allocator, HELD -> let go (the stock frees it later itself);
 *              frame 4 (the reference): the held frames whose ISO / shutter / aperture steps (as EXIF rounds them) equal
 *                the reference's, whose slot is still HELD or RELEASED and whose canary is unchanged, are merged with it
 *                (1..3 alternates, mf_merge_parts; mf14: the scratch in 3 IMAGE2 blocks, the output over the two
 *                level-0 parts: 26.5 + 26.6 + 17.4 MB at 6304 x 4210, asked largest first, all or nothing); the canaries and slots are checked again after the merge;
 *                only if everything succeeded within the time limit (30 s) the merged frame is copied over the frame's
 *                own Bayer buffer (the DNG and the JPEG of that frame are then the merged picture) and the frame's high-ISO
 *                NR byte [[recipe+0x5C]+0x1F] is set to 0.  The CPU's hardware data prefetcher (ACTLR bits 14:13,
 *                switched off by the boot code) is on while the merge runs.
 *            Frames 5.. of the same burst (less than 1 s apart) are left as they are.  A group of fewer than 4 frames,
 *            no usable alternate, too little memory, the time limit, a changed alternate, any error: nothing is written,
 *            the photos are the camera's own.  Each group writes one log file C:\MFxxxxxx.BIN (struct mf_log) with all its frames.
 *   which 1, a = FESequenceController, b = the stock value of SEQ+0xF1 (stop requested), e = the frame's ShootingInfo
 *            ([planEntry+0x10]): at 0x5367F904 in the per-frame decision of continuous drive (0x5367F838).  Switch off:
 *            returns b (stock).  Switch on: a shot whose ISO step is below ISO_GATE_STEP returns 1 (stop) at once, i.e. an
 *            ordinary single shot; otherwise 0 (continue) while SEQ+0x104 (frames so far, this one included) < 4, else 1
 *            (stop): one press, 4 frames.  In the back end a frame below the gate is not ours (no group, no copy, no log).
 *            mf14: a "continue" also notes its tick, count and SEQ for H2 (which 3); any stop answer drops that note.
 *   Waiting indicator: while the merge runs, state->busy is non-zero (a counter, one more at every wake-up; the live
 *            view draws the stock dot-ring spinner, step busy & 7, through the appended code of handnight.ts that reads the
 *            RAM slot); the UI task is woken with the application's "callback only" event 0x17D (a = 0, b = 0: no controller
 *            dispatch, no callback; the loop then runs its per-loop update and Render) at most every 200 ms and once more
 *            on every way out of the merge, when busy goes back to 0.
 *   which 3, a = FESequenceController, b = the stock value of SEQ+0xF1 | SEQ+0xF3 << 8 | SEQ+0x11A << 16 (the bytes the stock
 *            code holds in r3 / ip / r2 there), e = the plan entry's ShootingInfo: hook H2 at 0x5367E6AC in step 0x206 of the
 *            between-frames release check (plan 1), whose stock code copies the stop request into SEQ+0xF2 (which then ends
 *            the burst at 0x20B / 0x2FE: a tap gave 1 frame).  Returns 0 ("no stop yet") instead of the stock byte only while
 *            this press's group is open: switch on, continuous drive, SEQ+0xF8 set (the last 0x31D said continue), SEQ+0x104
 *            in 1..3, SEQ+0xF3 / 0x11A / 0x113 / 0x11E / 0x122 all clear, and H1's last "continue" (fe()) was for this
 *            SEQ and this count and is younger than TAP_LIMIT_US; otherwise the stock byte.  Every call goes into the
 *            h2 ring (log version 12, tap block).  The count, SEQ+0xF8 and SI+0x959 stay H1's and the stock's: at most 4
 *            frames per count (the research notes T7j).
 *   which 2, a = 0 / 1: the menu list "set" function (UI task).  On: saves drive mode, file format and long exposure
 *            NR into the switch byte, then sets RAW+JPEG, long exposure NR off, self-timer off, continuous drive with the
 *            camera's own setters.  Off: puts back each of the three that still has the value On gave it.
 *
 *   which 4 (mf17), the stock settings save at power-off (UI task): the user's auto-ISO values and drive back into CUR first.
 *   which 5 (mf17), the live view's per-loop update (UI task, switch on): the UI watchdog's guards, the auto-ISO limits, the
 *            night drive rule.
 * mf17 "night mode" (the research notes T7n; each switch below, 0 = mf16): the gate is ISO >= 3200 or EV100 <= 3.9; the
 *   power key stops the merge; frames 1-3 without direct view; a per-press log; the merged frame brightened (night_tone.c) and
 *   developed with NR Auto at an equivalent ISO and frame 1's white balance; single drive switched to continuous in the dark;
 *   auto-ISO slowest shutter 1/30 and upper limit 25600 while the switch is on.
 * mf22 "handheld night scene" (docs T7s): the full-screen panel off again (OSD_UNHIDE 0); Instant Review > Display Time Off while the
 *   switch is on, the user's value kept and put back (NIGHT_REVIEW); the merged frame taken away after the user's Display Time once it
 *   is on screen (REVIEW_END, state-driven: LCD layer 0 in direct draw); the event ring keeps no timer callbacks.
 * mf23 (docs T7t): the processing screen during the merge (PROC_SCREEN: LiveViewController +0x4E5 put back to 0 while nothing is on
 *   screen, the root draw paints the menu background and the spinner); the merged frame's log after the post's check (LOG_DEFER).
 *
 * mf24, the final build (docs T7u): PROBES 0 (no record written, no recording hook, no sample), KEEP_LAST_ONLY 1 (only the merged
 *   frame is stored: frames 1-3 get the stock "no file" byte at their store setup), PROGRESS_BAR 1 (the percent covers the write-back
 *   and the brightening; 100 % drawn once before the screen goes).
 *
 * Integer only, soft float, position independent, no data sections, no library calls; mfmod at offset 0.
 */
#include "c/mf_core.h"

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int s32;
typedef unsigned long long u64;
typedef void __attribute__((pcs("aapcs-vfp"))) (*fset_t)(u8 *, float);   /* the stock float setters take the value in s0 */
#include "c/night_tone.h"   /* mf17: the night brightening (TONE_HOOK); its code is included at the end */

struct ctx {
    u32 magic;
    u32 *slot;                                   /* RAM word: our state (operator new), 0 at start-up */
    u8 *sw;                                      /* the switch byte in the user settings */
    void *(*op_new)(u32);                        /* 0x539084BC */
    void (*op_delete)(void *);                   /* 0x539084F8 */
    u8 *(*timer_holder)(void);                   /* 0x53919D68: + 0xC timer */
    u32 (*tick)(void *);                         /* 0x5391CA64 */
    u32 (*elapsed)(void *, u32, u32, u32);       /* 0x5391CA74: (timer, earlier, later, 0) -> microseconds (27 MHz down-counter) */
    u8 *(*file_holder)(void);                    /* 0x537CF950: + 0x14 file service */
    void *(*img)(void);                          /* 0x538F6604: ImageBufferAllocator */
    void *(*img_alloc)(void *, u32, u32);        /* 0x538F6A28 (obj, size, pool type 0 = IMAGE1) */
    void (*img_free)(void *, void *);            /* 0x538F666C */
    void (*img_free_size)(void *, u32 *, u32 *, u32); /* 0x538F677C (obj, &total, &largest, pool type) */
    void *(*cache)(void);                        /* 0x53918010 */
    void (*flush)(void *, u32, u32);             /* 0x539180A0: clean + invalidate (task context; whole cache from 256 KB) */
    void (*discard)(void *, u32, u32);           /* 0x5391808C: invalidate only (would drop the CPU's dirty lines: not used) */
    void (*ui_prep)(void);                       /* 0x532406A4, called before CURRENT() by every stock setter caller */
    u8 *(*current)(void);                        /* 0x53240C38 CURRENT() */
    void (*set_format)(u8 *, u32);               /* 0x532FD208 */
    void (*set_lnr)(u8 *, u32);                  /* 0x532FDCF4 */
    void (*set_timer)(u8 *, u32);                /* 0x532FBACC */
    void (*set_drive)(u8 *, u32);                /* 0x532FB170 */
    void *(*copy)(void *, const void *, u32);    /* 0x53157380: the stock memcpy (NEON, reads ahead by itself) */
    const s32 *rcp;                              /* ref.RCP: 0 .. 64 * 8 */
    const u32 *ns_a;                             /* noise slope per ISO step (nominal ISO of the step), NS_FIRST .. NS_LAST: K * ls * 2^16 */
    u32 ns_b;                                    /* K * lr * 2^16 */
    void *(*app_queue)(void);                    /* 0x53240818: the application's event queue */
    void (*app_post)(void *, u32, u32, u32);     /* 0x5325E2D8 (queue, event, a, b): mutex, ring, event flag; any task */
    /* SMP T-Kernel calls for the merge's worker tasks (SVC stubs; handnight.ts checks each stub and a stock caller) */
    s32 (*cre_tsk)(const void *);                /* 0x5306764C tk_cre_tsk(T_CTSK *) -> task id > 0 */
    s32 (*sta_tsk)(s32, s32);                    /* 0x530683F0 tk_sta_tsk(id, stacd) */
    void (*exd_tsk)(void);                       /* 0x53067AA8 tk_exd_tsk(): exit and delete (the kernel frees the stack) */
    s32 (*del_tsk)(s32);                         /* 0x53067820 tk_del_tsk(id): a dormant task */
    s32 (*cre_sem)(const void *);                /* 0x53067628 tk_cre_sem(T_CSEM *) -> semaphore id > 0 */
    s32 (*sig_sem)(s32, s32);                    /* 0x530682F4 tk_sig_sem(id, count) */
    s32 (*wai_sem)(s32, s32, s32);               /* 0x530684EC tk_wai_sem(id, count, timeout ms; -1 forever) */
    s32 (*del_sem)(s32);                         /* 0x530677FC tk_del_sem(id): waiting tasks return E_DLT */
    /* version 8 */
    u32 (*tick_probe)(void *);                   /* the tick 0x5391CA64 through a one-word trampoline (handnight.ts): the probes'
                                                    readings (the emulator tells them apart from the merge's own readings) */
    const u8 *shown;                             /* 101 bytes: displayed percent of a true percent p, round(100 (p / 100)^1.3) */
    /* version 9 */
    s32 (*rot_rdq)(s32);                         /* 0x530681B0 tk_rot_rdq(priority): the next ready task of that priority runs */
    /* version 10 */
    s32 (*fe_post)(void *, void *);              /* 0x53643344 (SEQ + 0x10, message): the front end's post, as its shutdown preparation
                                                    0x53681268 sends 0x67C40802 (live view restart) to the live-view control */
    /* version 11 (mf14, spec v9) */
    const u32 *ws;                               /* the weights' noise model per ISO step NS_FIRST .. NS_LAST: A lo, A hi, B lo, B hi (u64 each),
                                                    A = K 2^16 1.004e-2 iso^0.843, B = K 2^16 iso / 50 (ref.weights_noise_consts; handnight.ts) */
    /* version 12 (mf17, night mode) */
    void (*nr_calc)(u8 *, u8 *, u32);            /* 0x53739840 (params, SI, type): params+0x1F (ELA on / off) and +0x21 from SI+0xBA0 / +0x7E7 */
    fset_t set_tvmin;                            /* 0x532B6D50 (CUR, s0 = float Tv): auto-ISO slowest shutter, stored CUR+0x108 (hard-float) */
    fset_t set_isoup;                            /* 0x532B6A28 (CUR, s0 = float Sv): auto-ISO upper limit, stored CUR+0x100 (hard-float) */
    u8 *user;                                    /* 0x550832AC: the saved user settings block (CUR + 4); our padding bytes NB_* in it */
    u32 *comprop;                                /* 0x5537B2A0: the ComPropIf slot (E, its vtable 0x53FC54D8; D = [[E+0x518]]) */
    const u32 *iso_tab;                          /* 0x5401CD84: the camera's nominal ISO per step (EXIF ISO) */
    /* version 13 (mf21, REVIEW_END) */
    void *(*pb_model)(void);                     /* 0x53240998: the App's playback command model (as CIM's StopReview 0x533EA808) */
    s32 (*pb_post)(void *, u32, u32, u32, void *);   /* 0x53262D1C (model, command, r2, r3, [sp] = 8-byte functor {0, 0}) */
    /* version 14 (mf22, NIGHT_REVIEW) */
    void (*set_review)(u8 *, u32);               /* 0x5333E5F8 (CUR, ms): Instant Review > Display Time, stored CUR+0x914 (saved) and
                                                    copied to CUR+0x1458 (what the review reads, 0x5329EC14) before it returns */
    /* version 15 (mf24) */
    void (*log_sink)(u32, u32, const void *, u32);   /* (kind, tick, record, bytes): 0 on the camera (handnight.ts); with PROBES 0 the
                                                    emulator puts a recorder here to read the records the build no longer writes */
};

#define MAGIC_STATE 0x5453464du          /* "MFST" */
#define LOG_MAGIC 0x474c464du            /* "MFLG" */
#define VERSION (PROBES ? 23 : 22)   /* 23: the recording build's live-view samples (rd) */
/* mf24, the final build (docs T7u).  PROBES 0: no record is written anywhere (no C:\MF* / C:\MP* file is opened), the recording hooks of
 * handnight.ts are not installed (the App's dispatch keeps a one-word key count for REVIEW_END), no sample, ring, press record,
 * bandwidth probe, stack paint or recipe dump; the merged frame's store no longer waits (LOG_DEFER off).  The group's record (struct
 * mf_log) stays the module's working state in RAM; ctx->log_sink (0 on the camera) hands it to the emulator.  1: mf23's recording
 * build, otherwise the same (test_final compares the two). */
#ifndef PROBES
#define PROBES 0
#endif
/* KEEP_LAST_ONLY 1: after a merged group, frames 1-3 that went into the merge store no file (the stock "no file" byte of the store
 * configuration, recipe+0xCF4+0x72, which the stock sets from recipe+0x43 for a multi-exposure retake / BE error stop; the store
 * handler 0x537314C4 then posts no item, so no file number either), only if their store setup comes after the merge succeeded; any
 * other outcome, or the store setup before the result, stores every frame as mf23.  0: mf23. */
#ifndef KEEP_LAST_ONLY
#define KEEP_LAST_ONLY 1
#endif
/* KEEP_FIRST 1: frame 1's store setup usually comes before the merge's result (the upstream build's camera tests: every group; the
 * research builds: sometimes), so KEEP_LAST_ONLY alone stored it.  With KEEP_FIRST, frame 1 gets the "no file" byte at its own store
 * setup when frame 2 of the same group has reached module 9 by then (it is in the group: the burst, the gate and the group's checks
 * passed for it) and the camera is not shutting down: whatever happens next, frame 2 is stored by the stock flow unless the group is
 * merged (then the merged frame is), so the card keeps at least one picture of the press (failure, power key, a short group, a frame
 * moved by the stock: frames 2.. stored as before).  0: the first upstream test build (frame 1 stored when its store came first). */
#ifndef KEEP_FIRST
#define KEEP_FIRST 1
#endif
#define KEEP_WAIT_US 20000000u           /* a kept "no file" decision is used only this long after the group's end */
#define REC_NOFILE 0x43                  /* recipe: the stock "store no file" request (SetupMultiRecipeParameter 0x5374085C, mode 1) */
#define REC_STORE_CFG 0xcf4              /* recipe: the store module's configuration (GetModuleConfig 0x53733880) */
#define SC_NOFILE 0x72                   /*   +0x72 = recipe+0x43 (SetupModuleConfig case 8, 0x5373406C); read by 0x537319C8 / 0x53731A58 */
#define SC_SI 0x34
#define SC_MULTI 0x73                    /*   +0x73 = recipe+0x44: with SI+0xB16 != 0 and +0x73 set the handler ignores +0x72 */
#define SI_STORE_ALT 0xb16
/* PROGRESS_BAR 1: the processing screen gets a thin bar under its spinner (handnight.ts), and the percent covers the whole module 9
 * work: alignment 40 %, merge 40 %, write-back 5 %, brightening 15 % (its two passes by bands), 100 % shown (held up to
 * PBAR_HOLD_MS for one draw) before the screen goes.  0: mf23's percent (45 / 55, 99 % until the end), no bar. */
#ifndef PROGRESS_BAR
#define PROGRESS_BAR 1
#endif
#define PBAR_HOLD_MS 150u
/* mf25 PROC_TEXT 1: the processing screen also shows one line of text under the bar ("多帧降噪处理中" / "多幀降噪處理中" /
 * "マルチフレームNR処理中" / "Multi-frame NR processing", by the camera's language), drawn by handnight.ts with the stock
 * StringView (text 1024 of the camera's text catalog).  The module itself does not change: gen.py only exports the value.
 * 0: mf24's screen (no text; the whole build equals mf24's). */
#ifndef PROC_TEXT
#define PROC_TEXT 1
#endif
#define REVIEW_STOP 0                    /* mf14/15: 1 (the UI task stopped the instant review 0.5 s into the merge); mf16: 0 */
/* mf17 "night mode" (the research notes T7n).  Each new behaviour has a switch here; 0 is the mf16 behaviour. */
#define SHUTDOWN_STOP 1                  /* power key during the merge (LiveViewControl +0xE3): stop, no restart post, no log; 0 mf16 */
#define HIDE_EARLY 0                     /* frames 1-3 of a group: no direct view (recipe+0xD = 1, as 0x53735FA4); 0 mf16.  mf17 had 1:
                                            when the back end was two frames behind (ISO >= 6400, short exposures) no picture
                                            at all during the merge, a black screen (camera mf17, docs T7o); mf18: 0 again */
#define PRESS_LOG PROBES                 /* a small file per press at frame 1's module 9 (C:\MPxxxxxx.BIN); 0 mf16 */
#define NR_AUTO 1                        /* merged frame: the camera's high-ISO NR, Auto, at the equivalent ISO; 0 mf16 (NR byte 0) */
#define NR_EQ_EIGHTHS 7                  /* the merge's measured noise reduction, 0.9 stop, in eighths (round(0.9 x 8) = 7) */
#define WB_FIRST 1                       /* merged frame: frame 1's white balance gains (SI+0x2EBE8..EE at Pipe1); 0 mf16 */
#define NIGHT_DRIVE 1                    /* single drive: continuous while the live view is dark (menu On no longer forces it); 0 mf16 */
#define NIGHT_LIMITS 1                   /* switch on: auto-ISO slowest shutter 1/30, upper limit ISO 25600; 0 mf16 */
#define TONE_HOOK 1                      /* night brightening hook before RAW_CODEC (menu line, default on); 0 mf16 */
/* mf18 (the research notes T7o).  0 is the mf17 behaviour. */
#define REVIEW_ARM 0                     /* mf19: 0 (camera mf18: the stock flow did not open the timed review, every second group
                                            black, docs T7p).  mf18 1: a merged group's end: the UI task puts CaptureImageModel +0x27 ("review this shot") back
                                            to 1, as the stock release does (0x533EAD3C), so that frame 4's QUICK_VIEW_READY opens the
                                            stock timed review (the camera's review time) and its end takes the picture away */
#define RV_WATCH PROBES                  /* mf19: the 10 s watch after a merged group (struct rv_watch) without the arm; 0 mf18 (only
                                            with REVIEW_ARM) */
#define EV_LOG PROBES                    /* mf19: the UI task's event ring, the playback post ring (handnight.ts EVENT_LOG writes them),
                                            the back end's module marks, into the group log and the next press log; 0 mf18 */
#define EV_RING_N 128u                   /* App events kept (the last 128; 0x17D without a callback only counted) */
#define PB_RING_N 32u                    /* playback queue posts kept (the last 32) */
#define EV_WORDS 7u
#define EV_WINDOW_US 15000000u           /* (the rings run all the time with the switch on; the press log after a group carries them) */
#define ASN_FIRST 1                      /* mf19: the merged frame's DNG AsShotNeutral (SI+0x38BA4..0x38BC0, the DNG value filler
                                            0x53829454 reads [obj+0x94]+0x38BA4) = frame 1's, both taken at the store's module setup
                                            (module 8, after JPEG_ENC: the JPEG path is untouched); 0 mf18 */
#define SI_ASN 0x38ba4                   /* 8 words: R num / den, G num / den, (2 words), B num / den */
#define REVIEW_WATCH_US 10000000u        /* the UI task watches CIM +0x24 / +0x27, the screen and live view this long after the end */
/* mf21 (the research notes T7r).  0 is the mf20 behaviour. */
#ifndef OSD_UNHIDE                       /* mf22: 0 (the user: the full-screen panel looked odd; the display is mf20's again) */
#define OSD_UNHIDE 0
#endif
                                         /* 1 (mf21): while the merge runs (busy) the UI task puts CaptureImageModel +0x25 ("the direct view's
                                            picture is on screen", set by EVT_PLAYBACK_DISPLAY_DIRECT_VIEW 0x24480208, 0x533EA934) back
                                            to 0, only while +0x27 = 0: LiveViewController's UpdateOsd 0x5318BEE0 then shows the OSD-main
                                            layer again (it hides the whole layer while +0x25 = 1 [E]); handnight.ts draws the full-
                                            screen panel while osd_full.  No message to the playback task or the back end. */
#ifndef REVIEW_END                       /* mf22: 1 (mf21 0) */
#define REVIEW_END 1
#endif
                                         /* mf22 (docs T7s): after a merged group, once the merged frame is on screen (the LCD's layer 0
                                            in direct draw, ScreenDevice +0xAA 0 -> 1 after the merge's end, the shooting screen, +0x27 = 0)
                                            and the user's review time later (the value NIGHT_REVIEW keeps; Off: at once; Hold: never),
                                            one CMD_PLAYBACK_DIRECT_AND_QUICK_VIEW_STOP 0x4441100C from the UI task the way StopReview posts
                                            it (0x53240998 -> 0x53262D1C, r2 = r3 = 0, an 8-byte zero functor); no CIM flag, no BE byte
                                            written (camera mf21: the stock posts the same command once in every group during the merge,
                                            BE +0x2DE 0, groups after it normal).  mf21 (built, off): the trigger was the App event 0x159
                                            in the event ring, and it put the BE bytes back */
/* mf22 NIGHT_REVIEW: with the switch on, Instant Review > Display Time (CUR+0x914, copy CUR+0x1458) is set to Off with the stock
 * setter 0x5333E5F8; the user's value is kept as a code in bits 3..5 of our flag byte NB_FLAGS (bit 2 "ours"), put back at Off
 * (only if it is still Off) and written straight into CUR+0x914 before the power-off save (which 4), as the auto-ISO limits. */
#ifndef NIGHT_REVIEW
#define NIGHT_REVIEW 1
#endif
/* mf23 PROC_SCREEN (docs T7t): while the merge runs, with nothing on screen (LCD +0xAA 0, CIM +0x25 0, +0x27 0) and LiveViewController
 * +0x4E5 = 1 (set by its own 0xC8 handler 0x5318B19C when the release's review is cancelled with no picture up: Display Time Off;
 * its per-loop refresh 0x5318F504 then shows nothing: UpdateOsd 0x5318BEE0 and UpdateVramAndOsdBack 0x5318F2F4 with show 0 turn
 * the three LCD layers off, camera mf22 "000" for the whole merge), the UI task writes +0x4E5 = 0 (the controller's own value at
 * its entry, 0x5318F748): the stock refresh then shows its layers as in any shooting screen (camera mf21 during the merge: "110")
 * and the root draw paints the full-screen dark background (an opaque fill, 720 x 480) with the stock spinner in the
 * middle.  Given back (+0x4E5 = 1 again, if still 0) at the merge's end and at a release, the power key, another screen or a
 * picture on screen: from there the stock flow is mf22's. */
#ifndef PROC_SCREEN
#define PROC_SCREEN 1
#endif
#define LVC_HIDE 0x4e5                   /* LiveViewController: "show nothing" (read only by its refresh 0x5318F52C) */
#define LVC_VT 0x53dbf740u               /* LiveViewController's vtable (handnight.ts hooks its slot +0x2C) */
#define CRM_GUARD 0x550830a0u            /* CaptureReadyModel (0x53240F38): guard bit 0, object; +0xB forces show 0 in the refresh */
#define CRM_OBJ 0x5508a010u
#define MSMP_N 32u                       /* merge samples (every 0.5 s from the merge's first UI loop) */
/* mf23 LOG_DEFER: the merged frame's group log (written in the back end at its module 7, before its store) waits there until the
 * UI task's check after the REVIEW_END post is done, or REVIEW_END ended without a post, or LOG_WAIT_US after the group's end, or
 * a release / the power key: the same safe point, later (the back end only, at most LOG_WAIT_US) */
#ifndef LOG_DEFER
#define LOG_DEFER PROBES                 /* mf24: only with a record to write */
#endif
#define LOG_WAIT_US 3000000u
#define CUR_REVIEW_SET 0x914             /* CUR +0x914: the saved Display Time (ms; 0 Off, 500, 1000, 2000, 3000, -1 Hold) */
#define RE_SHOW_US 1000000u              /* REVIEW_END: layer 0 in direct draw since the merge's end without a 0 seen: taken as shown
                                            after this long */
#define RE_CHECK_US 2000000u             /* REVIEW_END: after the post, +0xAA looked at for this long (no second post) */
#define OSD_GUARD_US 5000000u            /* D: our +0x25 = 0 still standing this long after the merge's end with the picture still up
                                            (LCD layer 0 in direct draw): put back to 1 (the stock's own state for a picture on screen) */
#define RE_WAIT_US 15000000u             /* B: the merged frame's READY looked for this long after the group's end */
#define DV_SAMPLES 20u                   /* the window after a group: one sample every 0.5 s for 10 s */
#define LCD_SLOT 0x553a281cu             /* ScreenDeviceFactory 0x553A2814 + 4 + 4 x device 1 (LCD): the ScreenDevice */
#define BE_GUARD 0x5537b218u             /* the still back end (0x5373D688): guard (bit 0) and the object */
#define BE_OBJ 0x5537a540u
#define CMD_DQV_STOP 0x4441100cu         /* CMD_PLAYBACK_DIRECT_AND_QUICK_VIEW_STOP */
#define TONE_MAX_Q8 128                  /* the brightening's noise limit N, and so g + d, at most this (stops x 256; 256 = 1.0 stop);
                                            0: no cap (mf17..mf19).  Final build (chosen on the camera, 2026-11-24): 128 = 0.5 stop, fixed, no menu
                                            line (camera mf17: ISO 3200 groups got +1.8 / +2.4 stops with N = 3.9) */
#define TONE_DMAX_Q8 64                  /* final build: the dark lift d at most 0.25 stop (night_tone_set_d_max); 0 = no cap (mf19) */
#define TONE_MENU 0                      /* final build: 0 = no brightening line in the menu, the old byte NB_TONE is ignored (kept,
                                            never written: a camera that had "Off" there from mf17..mf19 brightens now); 1 mf17..mf19 */
/* final build (docs T7q): the merged frame's whole white balance result = frame 1's.  WB_CALC (module 2) writes, from the
 * statistics, SI+0x2EBE8..EE (gains), +0x2EBF0..F6 (the gains times the headroom factor, clipped at 0x7FF), +0x2EC00..66 (the
 * stash table, incl. the Cte / Auto stashes +0x2EC58 / +0x2EC60), +0x34968..0x34A31 (light source detection), +0x38AE8 /
 * +0x38AEC / +0x38B08 (headroom words, +0x38B08 the factor) and +0x38BA4..0x38BE3 (the DNG AsShotNeutral rationals) [E,
 * emulated WB_CALC with two statistics]; mf17..mf19 copied only +0x2EBE8..EE and the camera's JPEG kept frame 4's colours.
 * With the switch on, all of them are kept at frame 1's Pipe1 and written into the merged frame's SI at its Pipe1 (after its
 * own WB_CALC).  0: mf19 (only the four gains, WB_FIRST). */
#define WB_FIRST_V2 1
#define V2_A 0x2ebe8                     /* +0x80 bytes: gains, headroom gains, the stash table */
#define V2_A_N 0x80u
#define V2_B 0x34968                     /* +0xCA bytes: light source detection */
#define V2_B_N 0xcau
#define V2_C 0x38ba4                     /* +0x40 bytes: AsShotNeutral rationals and the 8 words after them */
#define V2_C_N 0x40u
#define V2_HR0 0x38ae8                   /* headroom words */
#define V2_HR1 0x38aec
#define V2_HR2 0x38b08
#define V2_HW ((V2_A_N + V2_B_N + V2_C_N) / 2u)
#define AWB2_SLOT 0x55839078u            /* the learned AWB's state pointer (awb2.ts slot): its first 64 bytes are its diagnostic record */
#define AWB2_DIAG_MAGIC 0x31445741u      /* "AWD1" */
#define CIM_GUARD 0x55083240u            /* CaptureImageModel (0x532417E8): its construction guard (bit 0) and the object */
#define CIM_OBJ 0x55083138u
#define CUR_REVIEW 0x1458                /* CUR (0x550832A8, 0x53240C38) +0x1458: the review time in ms (0 off, -1 hold; 0x5329EC14) */
#define SHUTTER_SITE 0x536a7d1cu         /* the AE's I+0x74 getter (vldr s0, [r0, #0x74]): handnight.ts SHUTTER_CAP hooks it */
#define EV_GATE 998                      /* EV100 x 256 at or below which a shot is merged even under the ISO gate: 3.9 x 256 */
#define LIVE_EV_IN 998                   /* live view: dark at EV100 <= 3.9 ... */
#define LIVE_EV_OUT 1254                 /* ... bright again at >= 4.9 (x 256) */
#define DWELL_US 1000000u                /* a live-view state must hold this long before the drive is switched */
#define TV_NIGHT 0x40a00000u             /* Tv 5.0 = 1/30 s (the stock menu's bit pattern) */
#define SV_NIGHT 0x41500000u             /* Sv 13.0 = ISO 25600 (the stock menu's bit pattern) */
/* our bytes in the saved user settings (offsets from CUR + 4: alignment padding UserDataInitValue never writes, no stock access) */
#define NB_FLAGS 0x49                    /* bit 0 limits ours in CUR, bit 1 drive switched to continuous by us */
#define NB_TV_LO 0x4a                    /* the user's CUR+0x108 (u16 halves) */
#define NB_TV_HI 0x7a
#define NB_UP_LO 0xfa                    /* the user's CUR+0x100 */
#define NB_UP_HI 0x46e                   /* (the research builds had 0x772; 0x771..0x773 are the 4K / movie SR options' now) */
#define NB_TONE 0x79                     /* bit 0: night brightening off (menu; 0 = on) */
#define NBF_LIM 1u
#define NBF_DRV 2u
#define NBF_RV 4u                        /* mf22: Display Time ours (Off) in CUR; the user's value as RV_CODE in bits 3..5 */
#define NBF_RV_SHIFT 3u
#define CUR_TVMIN 0x108
#define CUR_ISOUP 0x100
#define CUR_TIMER 0x47a
#define CUR_STILL 0xb76                  /* 0 still mode (the closures publish only then) */
#define LVC_SHUT 0xe3                    /* LiveViewControl: VIEW_STOP of the shutdown preparation (0x536535EC) */
#define SCREEN_SHOOT 0x08000000u
#define R_DISP 0xd                       /* recipe: 1 = no direct view (0x53735FA4) */
#define REC_VT 0x53fbb4e8u
#define REC_VT_SET 0x537329c8u           /* [vt+0x40]: strb r1, [r0, #0xD] */
#define REC_VT_GET 0x537329d0u           /* [vt+0x44]: ldrb r0, [r0, #0xD] */
#define SI_NRSET 0x7e7                   /* high-ISO NR setting 0 Auto .. 5 Off */
#define SI_WB 0x2ebe8                    /* 4 x u16 final gains R, G1, G2, B (WB_CALC) */
#define MOD_ELA 10
#define MOD_WB 2
#define MOD_PIPE1 4
#define MOD_JPEG 7
#define MOD_STORE 8
#define PRESS_MAGIC 0x474c504du          /* "MPLG" */
#define PRESS_VERSION 6
#define GROUP 4u                         /* frames per group; the reference is the last */
#define GAP_US 1000000u                  /* frames further apart start over */
#define LIMIT_US 30000000u               /* the whole merge of a group.  First camera runs: one alternate about 30 s with the
                                            prefetcher off; the stock back end was blocked 20 s by our merge without harm */
/* hold slots (mf13): states of struct hslot.st, shared with the Free stubs of handnight.ts (atomic) */
#define H_EMPTY 0u
#define H_HELD 1u                        /* registered; the stock flow still owns the buffer */
#define H_RELEASED 2u                    /* the stock flow freed it (a stub skipped the Free): the block is ours to free */
#define H_DROPPED 3u                     /* the stock relocation moved it and freed the old block: our pointer is stale */
#define CANARY_ROWS 4u                   /* rows of the canary checksum (h * j / 5, j = 1..4, full width) */
#define REC_POOL 0x5c000028u             /* the recipe pool (CAPTURERECIPE): 6 recipes 0x4968 apart (camera logs mf10, mf12) */
#define REC_STRIDE 0x4968u
#define REC_N 6u
#define REC_WORDS 21u
#define POST_SAMPLES 20u                 /* UI samples after the group (4 a second for 5 s, handnight.ts) */
#define L1PCTL 0x6000u                   /* ACTLR bits 14:13: L1 data prefetch control (0 = off, as the boot code leaves it) */
#define WHITE_BELOW 3                    /* white level = 2^bits - 1 - black - 3 (the camera's own value, SI+0x38BF4, is computed
                                            after module 9: 0x5395A240; the camera's DNGs have 2..4 here) */
#define NS_FIRST 0                       /* ISO step i = round(3 (Sv - 1)), as the EXIF ISO (0x5391D140): i 0 = ISO 6, 12 = ISO 100 */
#define NS_LAST 51                       /* ISO 819200 */
#define H1_RING 16
/* mf14 tap (H2, which 3) */
#define H2_RING 16
#define TAP_LIMIT_US 2000000u            /* H2 answers "no stop" only this long after H1's last "continue" (camera mf12 / mf13: 0.18 ..
                                            0.86 s from a continue to the next frame's decision); then the stock cancel goes through */
#define H2_STOCK 1u                      /* flags of an h2 entry: the stock byte SEQ+0xF1 was set */
#define H2_F8 2u                         /*   SEQ+0xF8 (the last 0x31D said continue) */
#define H2_F3 4u                         /*   SEQ+0xF3 (cancel before the first frame) */
#define H2_11A 8u                        /*   SEQ+0x11A (interval cancel) */
#define H2_113 16u                       /*   SEQ+0x113 (fail factor) */
#define H2_11E 32u                       /*   SEQ+0x11E (shutdown preparation) */
#define H2_122 64u                       /*   SEQ+0x122 (stop factor) */
#define H2_DRIVE 128u                    /*   ShootingInfo +0x7BC == 1 (continuous) */
#define H2_COUNT 256u                    /*   SEQ+0x104 in 1..3 */
#define H2_MATCH 512u                    /*   H1's last continue: this SEQ, this count */
#define H2_YOUNG 1024u                   /*   ... and younger than TAP_LIMIT_US */
#define H2_CONT 2048u                    /*   answered 0 instead of the stock 1 */
#define ISO_GATE_STEP 24                 /* ISO step (round(3 (Sv - 1)), the EXIF ISO, see q3()) below which a shot is not merged:
                                            24 = ISO 1600 (final build, as up to mf12; mf13..mf19 27 = ISO 3200); below it an ordinary
                                            single shot.  EV_GATE 3.9 at 1/30 s f/2.8 is ISO 1600 too */
#define EV_CALLBACK 0x17du               /* the application's event that only runs a callback (none with b = 0) */
#define WAKE_US 200000u                  /* the indicator wakes the UI at most this often */
#define STRIP_ROWS 32u                   /* mf_core.c MF_STRIP_ROWS (checked against it at the end of this file) */
#define PHASE1_SHARE (PROGRESS_BAR ? 40u : 45u)   /* the indicator's percent: aligning the alternates 45 %, phase 2 (strips) 55 %;
                                            mf24 PROGRESS_BAR: 40 %, then the strips up to P_MERGED */
#define P_MERGED (PROGRESS_BAR ? 80u : 100u)     /* phase 2 ends here; the write-back to P_WRITTEN, the brightening's passes to 99 */
#define P_WRITTEN 85u
#define P_TONE1 92u
#define BW_BYTES (16u << 20)             /* the once-per-power-on bandwidth probe: bytes per thread */
#define PAINT 0xcdcdcdcdu                /* worker stack paint */
#define PAINT_BYTES 2048u                /* painted below a worker's entry stack pointer (half its stack) */
#define LV_RESTART 0x67c40802u          /* FE local message: live-view control starts live view (plan 3 step 0x405, shutdown preparation) */
#define LV_RUNNING 0x58u                 /* LiveViewControl: live view runs (byte; set by the 0x67C40802 handler after StartLiveView) */
#define LV_NET_BE 1u                     /* who re-posted the restart: the back end at the group's end */
#define LV_NET_UI 2u                     /*  ... the UI task's watchdog (handnight.ts) */
#define LV_NET_STOCK 0x100u              /*  ... nobody: live view was already running again (a stock start, e.g. mode dial, review exit) */
#define LV_NET_SHUT 0x200u               /*  ... nobody (mf17): the shutdown preparation stopped live view (LiveViewControl +0xE3) */
#define LV_NET_PRESS 0x400u              /*  ... nobody (mf17): a press since the hold and the front end busy: that shot restarts it */
#define P1_ROUNDS 11u                    /* rounds of jobs per alternate assumed before the first alternate is aligned (mf10: 34 a merge) */
#define MEM_GATE_BYTES (500u << 20)      /* frame 1 of a gated-in shot: IMAGE2 free in all below this -> the shot stops at 1 frame.
                                            Camera run mf10: 646..698 MB at frame 1 of every group that could merge, 291..343 MB
                                            (stock pipeline still busy with the previous bursts) in all ISO 6400+ groups, which
                                            then failed for memory at frame 4 */

/* settings (CURRENT() offsets; T7d.1) */
#define CUR_DRIVE 0x46f
#define CUR_FORMAT 0x49e
#define CUR_LNR 0x4a8
#define CUR_DRIVE_LIVE 0xfb3
#define DRIVE_CONTINUOUS 1u
#define FORMAT_RAW_JPEG 2u
#define LNR_OFF 2u
#define SW_ON 1u

/* recipe / ShootingInfo (T5, T7b.3, T7d) */
#define R_SEQTYPE 0x18
#define R_PARAMS 0x5c
#define R_BAYER 0x60
#define R_INFO 0x29c
#define R_LINE 0x2ba
#define R_BAYER_RAW 0x358
#define R_BAYER_SIZE 0x3bc
#define R_SI 0x4688
#define P_DNG 0xd
#define P_NR 0x1f
#define SI_DRIVE 0x7bc
#define SI_FORMAT 0x7d9
#define SI_INDEX 0x960
#define SI_SV 0xba0
#define SI_AV 0xb98                      /* float APEX Av: EXIF FNumber (0x53824710) */
#define SI_TV 0xb9c                      /* float APEX Tv: EXIF ExposureTime (0x53824590, default case) */
#define SI_TV_US 0x940                   /* u32 exposure time in us, used by the EXIF writer when SI+0x974 != 0; logged only */
#define SI_DEVELOP 0xb11
#define SI_CFA 0xb10
#define SI_BITS 0xb12
#define SI_BLACK 0x38be4
#define SI_WHITE 0x38bf4
#define SI_HC 0xbb7                      /* u8: highlight correction applied to this shot (sensor gain one stop below the ISO label);
                                            written by the AE capture fill 0x5369F780 (0x5369F864) with Sv; read by the MakerNote 0x0069
                                            writer 0x538356D8 and the BaselineExposure precompute 0x53939070 [C] */
#define SI_HC_SET 0x7e4                  /* u8: highlight correction setting 0 Auto / 1 On / 2 Off (MakerNote 0x0069 byte 1) [C] */
#define HC_STEPS 3                       /* applied: the weights' model uses the ISO step 3 below (ISO label / 2) */

/* results */
enum { R_NONE, R_MERGED, R_SHORT, R_EXPOSURE, R_MEMORY, R_TIME, R_ERROR, R_GEOMETRY, R_BROKEN, R_SWITCH_OFF, R_ISO, R_LEVELS, R_GATE,
       R_CANARY,                         /* 13: an alternate changed (canary) or was moved by the stock flow: nothing written */
       R_SHUTDOWN };                     /* 14 (mf17): power off during the merge: stopped, nothing written (no log file either) */

#define F_HELD 1u                        /* this frame's Bayer buffer was held (up to mf12: copied) */
#define F_NO_MEMORY 2u                   /* not held: IMAGE2's largest free block below one Bayer buffer (mf12: no block for a copy) */
#define F_GEOMETRY 4u                    /* size / pointer of this frame not usable */
#define F_USED 8u                        /* alternate used in the merge */
#define F_EXPOSURE 16u                   /* alternate not used: ISO / shutter / aperture step differs from the reference's */
#define F_CANARY 32u                     /* alternate not used: its canary changed before the merge */
#define F_DROPPED 64u                    /* alternate not used: the stock relocation moved its buffer */
#define F_NOSLOT 128u                    /* not held: its slot was not free or its address already held */

struct frame_log {
    u32 tick, gap_us, copy_us, recipe, bayer, index, seqtype, tv, av, sv, tv_us, white_si, chunk, flags;
    u32 img1_total, img1_largest, img2_total, img2_largest, img2_after;
    u16 px[32];                          /* 16 pixels from (row 40, column 40), 16 from the middle (even row and column) */
};

struct h1_log { u32 tick, count, stock, answer; };
struct h2_log { u32 tick, count, flags, answer, age_us; };   /* mf14 tap: answer = the returned byte; age_us of H1's continue
                                                                (0xffffffff: none for this SEQ / count) */

/* mf18 (REVIEW_ARM): the arm of a merged group's review and the UI task's watch for REVIEW_WATCH_US after the group's end
 * (times: microseconds from the end + 1, 0 never) */
struct rv_watch {
    u32 ret;                             /* 0 not reached; 1 | CIM +0x27 << 8 | +0x24 << 16 after the write; 0xEEE1 a group active,
                                            0xEEE3 +0x27 already set, 0xEEE4 +0x24 set, 0xEEE5 not the shooting screen, 0xEEE6 shutting
                                            down, 0xEEEF CIM not constructed */
    u32 arm_us;                          /* from the group's end to that decision */
    u32 review_ms;                       /* CUR +0x1458 then */
    u32 calls;                           /* UI loops (the live view's per-loop update) seen in the window */
    u32 gap_us, gap_at_us;               /* the longest pause between two of them (another screen up: the review), where it began */
    u32 t24_us;                          /* CIM +0x24 (ready seen) first 1 */
    u32 t27off_us;                       /* CIM +0x27 back to 0 after the arm (the review ended: StopReview, or a key) */
    u32 tscreen_us, screen;              /* another screen first seen, its id */
    u32 tback_us;                        /* the shooting screen again after a pause of 1 s or more, or after another screen */
    u32 tlv_us;                          /* LiveViewControl +0x58 first 1 */
    u32 last;                            /* at the last loop: +0x24 | +0x27 << 8 | LVC +0x58 << 16 (0xff unknown) | screen == shooting << 24 */
    u32 end_us;                          /* the window's length when it ended (0: still running) */
    u32 on, tick_last;                   /* (the watch runs; the tick of the last loop) */
};

/* mf21: the display watch (UI task).  The merge part is reset when the UI first sees the merge run; the window after the group
 * starts at the group's end (end_group) and runs DV_SAMPLES x 0.5 s or until the next group */
struct dv_watch {
    u32 on;                              /* the window after the group runs */
    u32 result;                          /* that group's result (R_*) | 0x100 when the window started */
    u32 osd_ticks;                       /* UI loops with the merge running */
    u32 osd_n;                           /* writes of CIM +0x25 = 0 (OSD_UNHIDE) */
    u32 osd_first_us, osd_last_us;       /* from the UI's first loop of the merge to the first / last write (+1) */
    u32 osd_skip;                        /* why not written while the merge ran (bits): 1 +0x27 set, 2 not the shooting screen, 4 CIM not
                                            constructed, 8 LiveViewControl unknown or shutting down, 16 +0x25 already 0 */
    u32 osd_full_n;                      /* UI loops with the full-screen panel requested */
    u32 held;                            /* 0 none; 1 our 0 stands; 2 the stock set +0x25 again (the merged frame's direct view); 3 put
                                            back to 1 by the guard (picture still up); 4 put back at a release start; 5 guard: no picture
                                            (left 0); 6 the stock cleared it itself / another release took over */
    u32 held_us;                         /* when held last changed (from the group's end, +1; 0 during the merge) */
    u32 at_end, lcd_end, lcd2_end;       /* first loop after the merge: CIM +0x24 | +0x25 << 8 | +0x26 << 16 | +0x27 << 24; LCD +0x3F |
                                            +0x40 << 8 | +0x41 << 16 | +0xAA << 24; +0xB1 | +0xB9 << 8 (0xffffffff not known) */
    u32 re_ret;                          /* REVIEW_END: 0 not reached; 1 | (post's return & 0xffff) << 8 posted; 0xEEE0 switch off;
                                            0xEEE1 a group / release started, 0xEEE2 a key, 0xEEE3 +0x27 set, 0xEEE4 the picture went
                                            before the time (+0xAA 0), 0xEEE5 not the shooting screen, 0xEEE6 shutting down, 0xEEE7
                                            review "hold", 0xEEE8 not shown in time, 0xEEE9 not merged, 0xEEEF CIM not constructed
                                            (log 19: 0xEEE4 was "+0x25 0", 0xEEE8 "no READY") */
    u32 re_shown_us, re_post_us;         /* from the group's end (+1): the merged frame on screen (+0xAA 1; log 19: the READY), the post */
    u32 re_review_ms;                    /* the wait used: the user's Display Time (NIGHT_REVIEW's kept value, else CUR +0x1458) */
    u32 re_be[3];                        /* record only (mf22): BE +0xCBC | +0xCBD << 8 | +0x2DE << 16 before the post and RE_CHECK_US
                                            after it; CIM word then (log 19: after the restore) */
    u32 re_gone_us;                      /* +0xAA first 0 after the post (+1 from the end; log 19: the back end's change) */
    /* mf22 (log 20) */
    u32 rvs_flags;                       /* NB_FLAGS at the window's start (bit 2 Display Time ours, bits 3..5 the user's code) */
    u32 rvs_user_ms;                     /* the user's Display Time kept (0xfffffffe: none kept) */
    u32 rvs_set_ms, rvs_rt_ms;           /* CUR +0x914 (saved) and +0x1458 (what the review reads) at the window's start */
    u32 re_chk_lcd;                      /* LCD word RE_CHECK_US after the post */
    u32 re_chk_lv;                       /* then: LVC +0x58 | shooting screen << 8 | +0x27 << 16 */
    u32 n;                               /* samples */
    u32 smp[DV_SAMPLES][5];              /* us from the end; CIM word; LCD word; LCD2 word | LVC +0x58 << 16 | shooting screen << 24
                                            (log 20); BE word */
    /* mf23 (log 21) */
    u32 ps_n;                            /* PROC_SCREEN: writes of LiveViewController +0x4E5 = 0 during the merge */
    u32 ps_first_us, ps_back_us;         /* from the merge's first UI loop (+1): the first write; when it was given back */
    u32 ps_back;                         /* how: 0 not taken / still ours; 1 merge end, put back 1; 2 a release; 3 the power key / shut;
                                            4 another screen; 5 a picture on screen; 6 the fallback (not busy); | 0x10 the stock had
                                            changed it already (left) */
    u32 ps_skip;                         /* why not taken (bits): 1 +0x27, 2 screen, 4 CIM, 8 LVC / shutdown, 16 +0x25, 32 +0xAA, 64
                                            controller unknown, 128 front end busy, 256 +0x4E5 already 0 */
    u32 ps_ctrl;                         /* the controller (its address) */
    u32 mn;                              /* merge samples */
    u32 msmp[MSMP_N][3];                 /* us from the merge's first UI loop; LCD word; +0x4E5 | ours << 4 | CRM +0xB << 8 | CIM +0x25 << 16
                                            | +0x27 << 24 */
};

/* mf19 (EV_LOG): the rings the appended code fills (handnight.ts installEventLog), copied into the logs */
struct ev_log {
    u32 n;                               /* App events seen (the ring holds the last EV_RING_N: entry i % EV_RING_N) */
    u32 skip;                            /* events only counted: log <= 19 0x17D without a callback (our wake-ups); log 20 (mf22) every 0x17D
                                            and 0x181 (the timer callbacks: camera mf21 had 11519 events in a group, all but a few timers) */
    u32 crm;                             /* CaptureReadyModel (its event handler's r0, noted by the hook) */
    u32 pb_n;                            /* playback queue posts seen (ring PB_RING_N) */
    u32 tick;                            /* the tick when this copy was made */
    u32 ev[EV_RING_N][EV_WORDS];         /* tick; event | screen low 16 << 16; a; b; CIM +0x24 | +0x27 << 8 | LVC +0x58 << 16 | root
                                            visible (+0x9E) << 24; CRM +8 | +9 << 8 | +0xB << 16 | +0xEE0 << 24; App live view +8 | +9 << 8
                                            | +0xA << 16 | LiveViewController +0x14E << 24 (0xff: object not known) */
    u32 pb[PB_RING_N][4];                /* tick, command, r2, r3 */
};

struct mf_log {
    u32 magic, version, bytes, result;
    u32 frames, tail_before, width, height, line, bayer_size, bayer_raw, cfa, bits;
    u32 black[4], white_used, black_used, iso_step, nshift, ntab[4];
    u32 need, block, block_pool, merge_us, stop_at, write_us, written, nr_before, nr_after, n_alt;
    u32 pools_merge[4];                  /* IMAGE1 total / largest, IMAGE2 total / largest when the merge block is asked */
    u32 align_us[MF_MAX_FRAMES - 1];
    struct mf_stats st;
    u16 out_px[32];                      /* the merged frame at the two places of frame_log.px */
    struct frame_log f[GROUP];
    u32 h1_seq;
    struct h1_log h1[H1_RING];
    u32 files, mode_before;
    /* version 3 */
    u32 bench[12];                       /* once per power-on, see bench() (up to mf13; 0 from mf14) */
    u32 pmin[6];                         /* since the previous log, over every module call: lowest IMAGE1 total / largest block and
                                            the module id at that moment, lowest IMAGE2 total / largest block, number of calls */
    /* version 4 */
    u32 actlr_before;                    /* ACTLR read right before the merge, before the prefetcher bits were set */
    /* version 5 */
    u32 vmax;                            /* limit of the merge (ref.py v8): 2^bits - 1, the largest value the raw data holds */
    /* version 6 */
    u32 iso_gate;                        /* ISO_GATE_STEP of this build */
    /* version 7: the merge on 3 cores (merge_mt) */
    u32 mt_threads;                      /* threads of the merge: 1 + workers started (1: single-thread fallback) */
    u32 mt_fail_step, mt_fail_code;      /* first kernel call that failed (MT_F_*, 0: none) and what it returned */
    u32 mt_setup_us;                     /* creating and starting the workers */
    u32 mt_phase1_us, mt_phase2_us;      /* from the merge's start: every alternate aligned (0: not reached); mf_merge_mt back */
    u32 mt_jobs[3];                      /* jobs run per thread (0 = this task, 1 and 2 = the workers) */
    u32 mt_busy_us[2];                   /* per worker: time from taking its first to finishing its last job, rounds summed */
    u32 mt_actlr[2];                     /* ACTLR each worker found when it started (its bits 14:13 are put back at its exit) */
    u32 mt_pri, mt_stack;                /* worker priority and stack bytes of this build */
    /* version 8: probes (0 where the path was not taken; h1_iso and pools_end are filled for every group) */
    u32 core_start;                      /* this task's core (MPIDR & 3) + 1 at the merge's start */
    u32 core_checks[4];                  /* stop checks of this task on cores 0..3 */
    u32 w_core[2][2];                    /* per worker: its core + 1 at its start, at its end */
    u32 jobs_p1[3], jobs_p2[3];          /* per thread (0 this task, 1 and 2 the workers): crew jobs in phase 1, in phase 2 */
    u32 job_busy_us[3], job_max_us[3];   /* per thread: time inside crew jobs, longest single job */
    u32 w_stack[2];                      /* per worker: deepest stack use below its entry stack pointer (bytes) */
    u32 w_wake_sum_us[2], w_wake_max_us[2];  /* per worker: from this task's go signal to the worker taking jobs, summed, longest */
    u32 m_wait_us;                       /* this task waiting for the workers' done signals, summed */
    u32 rounds;                          /* rounds of jobs handed to the workers */
    u32 t_ref_us, t_written_us;          /* from the merge's start: reference pyramid seen done (next round; 0 not seen), write-back done */
    u32 prev_log_us;                     /* writing the previous log file took */
    u32 bw_bytes, bw_us[3][3];           /* once per power-on: copy of bw_bytes per thread; [threads - 1][thread] microseconds + 1 (0: that
                                            thread did not copy) */
    u32 wakes;                           /* wake-up events posted to the UI */
    u32 ui_draws, ui_first, ui_last, ui_max_gap, ui_vt_fail, ui_core;   /* UI task (its appended code): indicator redraws, tick of
                                            the first and last (27 MHz down-counter), longest gap between two (ticks), the root
                                            check failed, its core + 1 at the last redraw */
    u32 h1_iso[H1_RING];                 /* per h1 entry: the frame's ISO step (low 16 bits, signed), bit 16: the gate answered */
    u32 pools_end[4];                    /* IMAGE1 total / largest, IMAGE2 total / largest after the group's blocks are freed */
    u32 progress_end;                    /* the indicator's word when it was hidden (percent + 1; 101: written back) */
    /* version 9 */
    u32 nr_frame[GROUP];                 /* per frame of the group: its high-ISO NR byte [[recipe+0x5C]+0x1F] + 1 before the module set it
                                            to 0 at module 9 (0: not set) */
    u32 mem_gate_bytes;                  /* MEM_GATE_BYTES of this build */
    u32 mem_gated, mem_skipped;          /* since the previous log: shots the front end stopped at frame 1 for memory; such frames the
                                            back end then left alone */
    u32 mem_total_last;                  /* IMAGE2 free in all at the last frame-1 decision of the front end */
    /* version 10: live view off during the merge, A/B (A: groups whose number is even), and what the UI task saw */
    u32 ab_letter;                       /* 1 A (live view restart deferred), 2 B (stock), 0 not decided */
    u32 ab_group;                        /* the group's number since power-on (front end, frame 1), + 1 */
    u32 lv_skips;                        /* StartLiveView calls our hook skipped for this group */
    u32 lv_net;                          /* LV_NET_* of the re-post (0: nothing deferred) */
    u32 lv_post_ret;                     /* the post's return value (and of the retry, high half, if any) */
    u32 lv_defer_us;                     /* from the front end's decision to defer (frame 4) to the re-post */
    u32 lv_prev_ui;                      /* the UI watchdog's re-post of an earlier group (net, written after that group's log) */
    u32 ui_calls;                        /* the live-view controller's per-loop update ran (our wrapper) during the group */
    u32 ui_nsamples;                     /* UI samples (once a second while the group is active), up to 8: */
    u32 ui_samples[8][3];                /*   screen id (0x5325E674), wrapper calls, indicator draws so far */
    /* version 11 (mf13): hold instead of copy, the merge block, recipe dumps, thread timing, live view after the group */
    struct hold_log {
        u32 raw, px, reg_tick, canary;   /* registration: allocation address, pixel pointer, tick, row checksum */
        u32 st_merge;                    /* slot state seen at frame 4 (H_*; 0xff: not held) */
        u32 final;                       /* resolution: 1 RELEASED -> freed by us, 2 HELD -> let go, 3 DROPPED (stock freed it), 0 none */
        u32 site, dup;                   /* stub site that released / dropped it (1 0x5374B394, 2 0x5374B030, 3 0x5374AAE0); repeated frees skipped */
        u32 canary_before, canary_after; /* 0 not checked, 1 same, 2 changed, 3 the allocator's block header changed (freed) */
        u32 caller, hdr;                 /* return address of the free the hook skipped / dropped; the block header [raw - 8] at registration */
    } hold[GROUP - 1];
    u32 hold_rule;                       /* IMAGE2's largest free block needed to hold a frame (one Bayer buffer, bytes) */
    u32 hold_frees;                      /* Free calls of this group for blocks the stock had released (RELEASED slots) */
    u32 merge_layout;                    /* 1 output over the scratch's pyramids, 2 separate output (old layout), 0 not asked */
    u32 out_room;                        /* mf_scratch_out_room of the frame size */
    u32 rec_n[2];                        /* recipes dumped (valid vtable) at frame 1 and at frame 4 */
    u32 rec[2][REC_N][REC_WORDS];        /* per recipe of the pool: step | +0x12 << 16 | +0xF << 24, seqtype, demand mask (ids
                                            0..24), address mask, sum of sizes, then (address, size) of ids 1 2 3 4 6 7 9 24 */
    u32 job_min_p2_us[3];                /* per thread: shortest phase-2 job (strips are alike: the pure compute time) */
    u32 busy_p_us[2][3];                 /* per phase, per thread: time inside crew jobs */
    u32 m_wait_p_us[2];                  /* per phase: this task waiting for the workers */
    u32 w_idle_us[2];                    /* per worker: waiting for its next go signal (from done to the next go seen) */
    u32 rounds_p[2];                     /* rounds of jobs per phase */
    u32 t_p2_us;                         /* from the merge's start: phase 2 begins (last alternate aligned) */
    /* the previous group's live view after its end (written by tasks running after that group's log) */
    u32 prev_lv_start_ret;               /* the re-posted start: StartLiveView's return + 1 (0: not seen) */
    u32 prev_lv_start_us;                /*   from the re-post to it */
    u32 prev_app_ret;                    /* the App's live-view Start 0x5326FE60 from the UI task: return + 1 (0: not called; 0xEEEF no App object) */
    u32 prev_app_us;                     /*   from the group's end to the call */
    u32 prev_post_n;                     /* UI samples after the group, up to POST_SAMPLES (4 a second for 5 s): */
    u32 prev_post[POST_SAMPLES][3];      /*   screen id; ms-ish (tick >> 15 since the end) | LVC+0x58 << 16 | +0x59 << 24;
                                              App live view +8 | +9 << 8 | +0xA << 16 | CIM+0x24 << 24 | CIM+0x27 << 28 */
    /* version 12 (mf14): the merge memory in parts (merge_layout 3; need = the bytes of the last try, block = its part 0) */
    u32 parts_tries;                     /* tries: 1 the 3-thread parts, 2 also the 1-thread parts (0: not asked) */
    u32 parts_threads;                   /* threads the last try was sized for */
    u32 out_split;                       /* full-res rows of the output over part 0 (the rest over part 1) */
    u32 part_size[2][MF_PARTS];          /* per try, per part: bytes asked (64 more than the part, for its alignment) */
    u32 part_addr[2][MF_PARTS];          /* per try, per part: the block (0: refused or not asked: the try then freed the others) */
    u32 part_pool[2][MF_PARTS + 1][2];   /* per try: IMAGE2 free total / largest before the first block and after each block (largest first) */
    /* the instant review of the 4th frame stopped from the UI task 0.5 s into the merge (CIM review stop 0x533EAFDC, handnight.ts) */
    u32 rv_ret;                          /* 0 not tried; 1 | CIM+0x27 << 8 | +0x24 << 16 after the call; 0xEEEF no CIM, 0xEEE3 no review up,
                                            0xEEE4 ready already seen, 0xEEE5 not the shooting screen */
    u32 rv_us;                           /* from the merge's start to that call */
    /* spec v9: the weights' own noise model (ref.py v9 ntab_w), from the highlight-correction state */
    u32 hc_src;                          /* how the reference's state was decided: 1 SI+0xBB7 (0 or 1), 2 fallback by black (>= 2048 not applied) */
    u32 hc_applied;                      /* the state used: 1 applied (model ISO step = ISO step - 3), 0 not applied */
    u32 w_step;                          /* ISO step of the weights' model */
    u32 w_a[2], w_b[2];                  /* its A, B (u64, lo / hi) */
    u32 nshift_w, ntab_w[4];             /* the weights' table: shift and entries 0, 16, 128, 255 */
    struct hc_log {
        u32 flags;                       /* SI+0xBB7 | SI+0x7E4 << 8 | black >= 2048 << 16 | 1 << 24 (logged) */
        u32 si_b80[16];                  /* raw SI+0xB80 .. +0xBBF */
        u32 si_7e0[2];                   /* raw SI+0x7E0 .. +0x7E7 */
    } hc[GROUP];
    /* version 13 (mf15): the merge in stages (MF_ST_* of mf_core.h: 0 pyramids, 1 levels 3-2, 2 level 1, 3 level 0, 4 brightness
     * gain (phase 1, summed over the frames); 5 phase-2 setup, 6 row pipeline, 7 after it), from the core's marks on this task */
    u32 st_us[MF_STAGES];                /* per stage: from its mark to the next one (this task's clock, every thread working) */
    u32 st_tail_us[MF_STAGES];           /* per stage: from the first thread finding no job left to the end of the round, summed
                                            over the stage's rounds (the threads' imbalance; 0 with one thread) */
    u32 st_rounds[MF_STAGES];            /* rounds of jobs handed to the workers per stage */
    u32 spec;                            /* the merge's spec version (ref.py VERSION of this core) */
    /* version 14 (mf16): the UI task's fallback after the previous group (state fb_ret, see struct state +0x20C) */
    u32 prev_fb_ret;                     /* 0 not reached (or no previous group), else fb_ret */
    u32 prev_fb_us;                      /* from the previous group's end to that decision */
    u32 review_stop;                     /* REVIEW_STOP of this build */
    /* version 15 (mf17, night mode; docs T7n).  Words after the group's end (the merged frame's modules 10, 2, 4, 7) are in this
     * same file: with a merged frame the log is written at its module 7 (JPEG_ENC), else at the group's end as before */
    u32 build_flags;                     /* BF_* of this build */
    u32 ev_gate;                         /* EV_GATE */
    s32 ev256[GROUP];                    /* per frame: EV100 x 256 = (Av + Tv - Sv + 5) x 256 from its SI (0x7fffffff: not a number) */
    u32 gate[GROUP];                     /* per frame: 1 ISO step >= ISO_GATE_STEP, 2 EV100 <= EV_GATE, 3 both */
    u32 shut;                            /* 0; 1 the merge stopped for the power key (LiveViewControl +0xE3), 2 +0xE3 seen at the group's end */
    u32 lv_e3;                           /* LiveViewControl +0xE3 | +0x58 << 8 at the group's end (0xffff: object not known) */
    u32 fe_plans;                        /* the front end's 6 plan entries in use (bit i), at the group's end (0x100: sequencer not known) */
    u32 arm_h2, h2_end;                  /* H2 calls (all presses) when the restart was held (frame 4), and at the group's end */
    u32 hide[GROUP];                     /* per frame: recipe+0xD before | after << 8 | why << 16 (HIDE_*), 0: not looked at */
    u32 nr_prep;                         /* merged frame: params+0x1F as prepared (+ 1; 0: not seen) */
    u32 nr_new;                          /* ... after 0x53739840 at the equivalent ISO (+ 1; 0 not called), | demand byte +0x33E << 8 */
    u32 sv_nom, sv_eq;                   /* SI+0xBA0 nominal and equivalent (float bits) */
    s32 idx_eq;                          /* the equivalent ISO index (1/8 stop, round(8 Sv) - 8) */
    u32 nrset_nom;                       /* SI+0x7E7 as set by the user */
    u32 eq_mod[4][2];                    /* modules 10, 2, 4, 7 of the merged frame: SI+0xBA0 found | SI+0x7E7 << 24... (see EQ_*), written */
    u32 wb1[2];                          /* frame 1's SI+0x2EBE8..EE at its Pipe1 (module 4): R | G1 << 16, G2 | B << 16 */
    u32 wb4[2][2];                       /* the merged frame's at its Pipe1: before, after */
    u32 wb_state;                        /* 0 not reached, 1 written, 2 frame 1 not seen, 3 same already, 4 switch off */
    u32 tone_on, tone_ret, tone_us;      /* night brightening: menu on, the hook's return (+ 1; 0 not called), time */
    s32 tone_g_q8, tone_d_q8, tone_n_q8, tone_lift_q8;   /* global gain, dark lift, noise limit, total dark lift (stops x 256) */
    u32 tone_changed;
    s32 boost8;
    s32 tone_full_q8, tone_cap_q8;       /* AGC gain without / with the highlight limit (stops x 256) */
    u32 tone_q16[5];                     /* g, d, N, g_full, g_cap in Q16 */
    u32 tone_clip[3];                    /* pixels at white before, after, change per million */
    u32 tone_wb[4];                      /* the gains it was given (Q12) */
    u32 tone_scale_q16, tone_iso;        /* its luminance scale and ISO */
    u32 tone_t[3];                       /* from its start: init done, pass 1 done, plan done (us) */                          /* the stops (x 8) added to the equivalent ISO: round(tone_lift_q8 / 32) */
    u32 press_files;                     /* press logs written since power-on */
    u32 nb_flags;                        /* NB_FLAGS at frame 1 */
    u32 tvmin, isoup;                    /* CUR+0x108, +0x100 at frame 1 (float bits) */
    u32 user_tvmin, user_isoup;          /* the user's values kept in NB_* */
    u32 nd_switches;                     /* drive switches by the live-view rule since power-on (to continuous | back << 16) */
    s32 nd_ev;                           /* the last live-view EV100 x 256 (0x7fffffff: not read) */
    u32 ui_ticks;                        /* night-mode UI calls since power-on */
    /* version 16 (mf18; docs T7o) */
    struct rv_watch prev_rv;             /* the previous group's review arm and the watch after it (its words came after its log) */
    struct rv_watch rv;                  /* this group's, as far as it got when this log was written */
    u32 rv_win_us;                       /* REVIEW_WATCH_US (0: REVIEW_ARM off) */
    u32 tone_nmax_q16;                   /* the cap given to night_tone (stops Q16; 0x7fffffff none, 0 not reached) */
    u32 shutter_word;                    /* the word at 0x536A7D1C (0xED900A1D: no shutter cap hook in this build) */
    /* version 17 (mf19; docs T7p) */
    u32 bem[GROUP][4];                   /* per frame of the group: the tick of its module 14 (DIRECT_VIEW), 6 (resize), 7 (JPEG_ENC, after
                                            NotifyView: QUICK_VIEW_READY is posted before it), 8 (store) setup; 0 not seen */
    u32 asn1[8], asn4[2][8];             /* frame 1's SI+0x38BA4.. at its store setup; the merged frame's before / after */
    u32 asn_state;                       /* 0 not reached, 1 written, 2 frame 1's not taken, 3 frame 1's values not set (0 denominators),
                                            4 equal already */
    struct ev_log evl;                   /* the rings when this log was written */
    /* version 18 (final build; docs T7q) */
    u32 wbv2_state;                      /* 0 not reached, 1 written, 2 frame 1's not taken, 4 equal already, 5 WB_FIRST_V2 off; mf22 (log 20):
                                            bits 8..12 the v2_put mask (sections written; bit 12 AsShotNeutral left) */
    u32 wbs1[20];                        /* frame 1's white balance set at its Pipe1 (wb_set_of): gains, headroom gains, +0x38AE8 / AEC /
                                            B08, Cte / Auto stash, +0x34968, AsShotNeutral */
    u32 wbs4[2][20];                     /* the merged frame's at its Pipe1, before / after */
    u32 awbd1[16], awbd4[16];            /* the learned AWB's diagnostic record at frame 1's / the merged frame's Pipe1 (0: none) */
    u32 tone_dmax_q16;                   /* the d cap given to night_tone (0x7fffffff none, 0 not reached) */
    u32 tone_menu;                       /* TONE_MENU | the old menu byte (NB_TONE) << 8 */
    /* version 19 (mf21; docs T7r) */
    struct dv_watch prev_dv;             /* the previous group's display watch (merge part and the window after it) */
    struct dv_watch dv;                  /* this group's, as far as it got (the merge part is complete) */
    /* version 21 (mf23) */
    u32 log_wait_us;                     /* LOG_DEFER: how long the back end waited at the merged frame's module 7 */
    u32 log_wait_why;                    /* 0 no wait, 1 the post's check done, 2 REVIEW_END over without a post, 3 LOG_WAIT_US, 4 a
                                            release, 5 the power key, 6 LOG_DEFER off, 7 no semaphore */
    /* version 22 (mf24) */
    u32 keep[GROUP - 1];                 /* KEEP_LAST_ONLY per frame 1-3 (KP_*) | ms after the group's end << 8, as far as known */
    u32 prev_keep[GROUP - 1];            /* the previous group's, complete (frame 3's store setup often comes after this log) */
    u32 keep_flags;                      /* KEEP_LAST_ONLY | PROBES << 1 | PROGRESS_BAR << 2 */
#if PROBES
    /* version 23 (recording build only): with each merge sample (dv.msmp, every 0.5 s of the merge) the appended live-view code's
     * counters (handnight.ts, PROBES 1): the live view's root rendered by the layer render (it reached our draw), our processing-screen
     * draws, the root invalidations asked | those that left the root marked (+0xA0 set) << 16 */
    u32 rd_n;
    u32 rd[MSMP_N][3];
#endif
    /* ---- version 12, tap block (mf14 change 3, H2 at 0x5367E6AC): keep at the very end of struct mf_log ---- */
    u32 h2_limit_us;                     /* TAP_LIMIT_US of this build */
    u32 h2_seq;                          /* H2 calls since power-on (the ring's next index is h2_seq % H2_RING) */
    u32 h2_cont;                         /* H2 answers "no stop" (0 instead of the stock 1) since power-on */
    struct h2_log h2[H2_RING];           /* the last H2_RING calls: tick, SEQ+0x104, H2_* flags, answer, age of H1's continue */
    /* ---- end of the tap block ---- */
};

/* the per-press log (mf17): written at frame 1's module 9 of every press with the switch on, so that a later freeze still
 * leaves the state of the last press on the card */
struct press_log {
    u32 magic, version, bytes, tick;
    u32 since_end_us;                    /* from the last group's end (0xffffffff none) */
    u32 fb_ret, fb_us;                   /* the UI's 3 s rule after that group (0xEEE7: would have posted, nothing sent) */
    u32 post_n, post[POST_SAMPLES][3];   /* the UI samples after that group so far */
    u32 h1_seq; struct h1_log h1[H1_RING]; u32 h1_iso[H1_RING];
    u32 h2_seq, h2_cont; struct h2_log h2[H2_RING];
    u32 mem_total_last, mem_gate;        /* the front end's last frame-1 memory decision */
    u32 img2[2];                         /* IMAGE2 free total / largest now */
    u32 sv, tv, av, index, drive, seqtype, develop, dng;   /* this frame */
    s32 ev256; s32 iso;                  /* EV100 x 256, ISO step */
    u32 lv[4];                           /* lv_armed, lv_deferred, LVC +0x58 | +0xE3 << 8 (0xffff unknown), ui_hold */
    u32 fe_plans;                        /* front-end plans in use (0x100 unknown) */
    u32 nb_flags, nd_dark, nd_switches; s32 nd_ev;
    u32 phase, count, result_prev;       /* the back end's group state at this frame, the previous group's result */
    /* version 2 (mf18) */
    struct rv_watch rv;                  /* the last merged group's review arm and watch, so far */
    /* version 3 (mf19) */
    u32 asn_state, asn1[8], asn4[2][8];  /* the previous group's AsShotNeutral (its store came after its log was written) */
    u32 bem[GROUP][4];                   /* the previous group's module marks, complete now */
    struct ev_log evl;                   /* the rings up to this press (the previous group's tail, this press's release) */
    /* version 4 (mf21) */
    struct dv_watch dv;                  /* the last group's display watch so far */
};

struct state {
    u32 magic;
    /* the waiting indicator, at fixed offsets read by the UI task's appended code (handnight.ts): +4 written by the back end
     * only, +8 by the UI task only */
    volatile u32 busy;                   /* 0 hidden; while the merge runs a counter (one more at every wake-up, never 0) */
    volatile u32 ui_busy;                /* the value the UI task last invalidated the live view for */
    volatile u32 progress;               /* +0xC, back end: 0 hidden, else the displayed percent + 1 */
    /* +0x10 .. +0x24, written by the UI task's draw code only (log version 8): redraws, first / last tick, longest gap,
     * root check failed, core + 1 */
    volatile u32 ui_draws, ui_first, ui_last, ui_max_gap, ui_vt_fail, ui_core;
    /* +0x28 .. +0xBC, fixed offsets for the appended code (handnight.ts), log version 10:
     * +0x28 lv_armed     front end (frame 4, an A group) / back end / UI watchdog: the group number + 1 whose live-view restart is held
     * +0x2C lv_deferred  the StartLiveView hook (task LiveViewCtrl) skipped a start; taken back by atomic exchange by whoever re-posts
     * +0x30 lv_obj       the LiveViewControl object (hook)          +0x34 lv_skips  starts skipped (hook)
     * +0x38 lv_seq       the FESequenceController (front-end hook)  +0x3C lv_arm_tick  tick of the decision to defer
     * +0x40 lv_ui_net    the UI watchdog's re-post (net)            +0x44 lv_ui_ret    its post's return value
     * +0x48 active       a group is being collected or merged (back end), the UI samples while it is set
     * +0x4C ui_frame     spinner frame the live view was last invalidated for (UI)
     * +0x50 ui_calls, +0x54 ui_sample_tick, +0x58 ui_nsamples, +0x5C ui_samples[8][3] (UI) */
    volatile u32 lv_armed, lv_deferred, lv_obj, lv_skips, lv_seq, lv_arm_tick, lv_ui_net, lv_ui_ret, active;
    volatile u32 ui_frame, ui_calls, ui_sample_tick, ui_nsamples, ui_samples[8][3];
    volatile u32 ev_keys;                /* +0xBC (mf24): App events 1..0x2D (switches / keys) the dispatch stub saw (handnight.ts, both
                                            builds; REVIEW_END's "a key since the group's end") */
    /* +0xC0: the hold slots, read and written by the Free stubs (handnight.ts, any task) with ldrex / strex */
    struct hslot { volatile u32 word, site, dup, caller; } hold[GROUP - 1];   /* word = allocation address | H_* (one atomic word) */
    /* +0xF0 .. : live view after the group (handnight.ts, fixed offsets):
     * +0xF0 app_req      back end: the merge's start tick | 1 (mf14: the UI task stops the instant review 0.5 s later, by exchange)
     * +0xF4 app_ret      UI: review stop result     +0xF8 app_tick   UI: tick of that call     +0xFC lv_watch  back end: re-posted
     * +0x100 lv_start_ret  StartLiveView hook: the re-posted start's return + 1        +0x104 lv_start_tick  its tick
     * +0x108 post_on     back end: sample after the group     +0x10C post_t0  tick of the group's end
     * +0x110 post_last   UI: tick of the last sample          +0x114 post_n   +0x118 post[POST_SAMPLES][3]
     * +0x208 lv_post_tick  back end: tick of the re-post
     * +0x20C fb_ret      UI (mf16): the fallback 3 s after the group: 0 not reached, 0xEEE1 a group active, 0xEEE5 not the
     *                    shooting screen, 0xEEE2 live view runs (nothing to do), 0xEEEF no LiveViewControl / sequencer; else the
     *                    restart re-posted: 0x10000 | the post's return (low 16 bits)     +0x210 fb_tick  tick of that decision */
    volatile u32 app_req, app_ret, app_tick, lv_watch, lv_start_ret, lv_start_tick, post_on, post_t0, post_last, post_n;
    volatile u32 post[POST_SAMPLES][3];
    volatile u32 lv_post_tick;
    volatile u32 fb_ret, fb_tick;
    volatile u32 ui_hold;                /* +0x214 (mf17): the UI watchdog waits (a press since the hold and the front end busy) */
    /* +0x218 .. (mf19, EV_LOG): written by the appended hooks (handnight.ts installEventLog), fixed offsets: event count, skipped
     * 0x17D count, the CaptureReadyModel, the LiveViewController (the wrapper), playback post count, the two rings */
    volatile u32 ev_n, ev_skip, ev_crm, ev_ctrl, pb_n;
    volatile u32 ev_ring[EV_RING_N][EV_WORDS];
    volatile u32 pb_ring[PB_RING_N][4];
    volatile u32 osd_full;               /* +0x122C (mf21): the full-screen "processing" panel (handnight.ts root draw), UI task */
    struct dv_watch dv;                  /* mf21: UI task */
    struct dv_watch dv_prev;             /* (the window of the group before, kept when the next merge starts) */
    volatile u32 dv_req;                 /* back end: at a group's end, result | 0x100 */
    u32 dv_t0;                           /* that end's tick */
    u32 dv_busy, dv_busy_t0, dv_end_t0;  /* UI: the merge seen running, its first loop's tick, the first loop after it */
    u32 dv_27, dv_scan, dv_ev0;          /* UI: +0x27 at the last loop, the event ring's next entry to look at, ev_n at the window's start */
    u32 dv_tshow, dv_posted, dv_tpost;   /* UI: tick the merged frame was seen on screen; posted (1; 2 checked); tick of the post */
    u32 dv_aa0;                          /* UI: +0xAA seen 0 since the merge's end */
    u32 ps_ours;                         /* mf23: +0x4E5 written 0 by us and not given back */
    u8 *ps_ctrl_p;                       /* that controller */
    volatile u32 dv_rel;                 /* mf23: a release seen by the UI since the group's end (the back end's log wait) */
    u8 *hpx[GROUP - 1];                  /* held frames' pixel pointers */
    u32 canary[GROUP - 1];               /* their row checksums at registration */
    u32 hdr[GROUP - 1];                  /* their pool block headers [raw - 8] at registration (the pool's free clears it) */
    u16 hsample[GROUP - 1][32];          /* their 32 sample pixels at registration */
    u32 hold_frees;
    u32 phase;                           /* 0 idle, 1 collecting a group, 2 tail of a burst whose group is over */
    u32 count, last_tick, merge_tick, files, tail;
    s32 q[GROUP - 1][3];                 /* their exposure steps */
    u8 *blk[MF_PARTS];                   /* the merge's blocks of IMAGE2 (mf14: the scratch in parts, the output over parts 0, 1) */
    u32 frame_bytes, copy_bytes, bayer_size;
    u32 width, height;
    void *timer;
    u32 pmin[6];
    u32 actlr;                           /* ACTLR as found before the merge (its bits 14:13 are put back after it) */
    u32 wake_tick;                       /* last wake-up of the UI task */
    u32 wakes, shown_max, prev_log_us, bw_done;
    volatile u32 mt_phase2;              /* the merge's last alternate is aligned: crew jobs from here on are phase 2 */
    volatile u32 mem_gate;               /* the front end stopped the current shot at frame 1 for memory (its frame is not ours) */
    u32 ab_count, ab_burst, ab_letter;   /* groups the front end let start since power-on; the current burst's number + 1 and letter
                                            (mf13: always 1, live view held off for every group) */
    u32 group_burst;                     /* the back end's group: the burst number + 1 it belongs to */
    void *q_active;                      /* the merge's stopper while it runs (progress from the job rounds) */
    u32 p1_rounds, p1_r_last, p1_alts;   /* phase 1: rounds handed out, rounds when the last alternate was aligned, alternates aligned */
    u32 mem_gated, mem_skipped, mem_total_last;
    u32 h1_iso[H1_RING];
    volatile u32 h1_seq;
    struct h1_log h1[H1_RING];
    s32 ntab[MF_NOISE_BINS];
    s32 ntab_w[MF_NOISE_BINS];           /* spec v9: the weights' noise table */
    u8 hcf[GROUP - 1];                   /* the held frames' SI+0xBB7 */
    struct mf_log log;
    /* mf17 (before the tap fields, which test_tap reads at the end of the state) */
    u32 arm_h2;                          /* h2_seq when the front end held the restart (frame 4) */
    u32 fe_burst, fe_n;                  /* the front end's current burst (ab_burst) and its count so far */
    u32 shut;                            /* the merge stopped for the power key */
    u8 *eq_recipe; u32 eq_index;         /* the merged frame (its recipe and SI index) until its module 7 */
    u32 eq_sv, eq_sv_nom, eq_nr_nom;     /* its equivalent / nominal Sv (bits), the user's SI+0x7E7 */
    u32 eq_nr;                           /* 1: Sv / NR are changed for it */
    u8 *wb_recipe; u32 wb_index;         /* frame 1 of the group: its recipe and index (its Pipe1 gives wb1) */
    u16 wb1[4]; u32 wb1_ok;
    u8 *asn_recipe; u32 asn_index;       /* mf19: frame 1 of the group (its store setup gives asn1) */
    u32 asn1[8]; u32 asn1_ok;
    u8 *asnm_recipe; u32 asnm_index;     /* the merged frame until its store setup */
    u32 log_due;                         /* the group's log waits for the merged frame's module 7 */
    u32 log_due_tick;
    u32 press_files;
    u32 nd_dark, nd_cand, nd_tick, nd_switches, ui_ticks;
    s32 nd_ev;
    u32 last_end_tick;                   /* the last group's end (press log) */
    struct press_log plog;               /* (built here, not on the back end task's stack) */
    /* mf18 (REVIEW_ARM) */
    volatile u32 rv_req;                 /* back end: 1 at a merged group's end (never with the power key / while shutting down) */
    u32 rv_t0;                           /* that end's tick */
    struct rv_watch rv;                  /* UI task: the arm and the watch */
    /* final build (WB_FIRST_V2): frame 1's white balance result, kept at its Pipe1 (before the tap fields: they stay last) */
    u16 v2[V2_HW]; u32 v2hr[3]; u32 v2_ok;
    /* mf24 KEEP_LAST_ONLY: frames 1-3 of the last merged group whose store is still to come (recipe, SI index), the store setups seen
     * while the group was open, the results */
    struct kp { u8 *recipe; u32 index; } kp[GROUP - 1];
    u32 kp_on, kp_seen, kp_t0, kp_res[GROUP - 1], kp_prev[GROUP - 1];
    u32 kp_first;                        /* KEEP_FIRST: frame 1's decision at its store setup (KP_* | ms << 8), 0 none yet */
    volatile u32 pbar_draws;             /* (PROGRESS_BAR: ui_draws when 100 % was set) */
#if PROBES
    u32 rd_n, rd[MSMP_N][3];             /* version 23: the merge samples' live-view counters (copied into the group's log) */
#endif
    /* mf14 tap (H1 / H2), after the existing fields */
    u32 cont_tick, cont_n;               /* H1's last "continue": its tick and SEQ+0x104 (cont_n 0: none, or H1 ended the burst) */
    u8 *cont_seq;                        /*   and its FESequenceController */
    u32 h2_seq, h2_cont;
    struct h2_log h2[H2_RING];
};

static u32 rd32(const void *p, u32 o) { return *(const volatile u32 *)((const u8 *)p + o); }
static u16 rd16(const void *p, u32 o) { return *(const volatile u16 *)((const u8 *)p + o); }
static u8 rd8(const void *p, u32 o) { return *(const volatile u8 *)((const u8 *)p + o); }
static u32 ram(const void *p) { u32 a = (u32)p; return a >= 0x55000000u && a < 0xe0000000u && !(a & 3); }

static struct state *get_state(const struct ctx *c, u32 create);
static void be(const struct ctx *c, u8 *recipe, u32 module);
static void ui(const struct ctx *c, u32 value);

static u32 fe(const struct ctx *c, u8 *seq, u32 stock, const u8 *si);
static u32 tap(const struct ctx *c, u8 *seq, u32 regs, const u8 *si);
static void save_hook(const struct ctx *c);
static void ui_tick(const struct ctx *c);

u32 mfmod(const struct ctx *c, u32 which, u32 a, u32 b, u32 e)
{
    if (which == 0) { be(c, (u8 *)a, b); return 0; }
    if (which == 1) return fe(c, (u8 *)a, b, (const u8 *)e);
    if (which == 2) ui(c, a);
    if (which == 3) return tap(c, (u8 *)a, b, (const u8 *)e);
    if (which == 4) save_hook(c);                                  /* mf17: the settings save at power-off (UI task) */
    if (which == 5) ui_tick(c);                                    /* mf17: the live view's per-loop update (UI task), switch on */
    return 0;
}

/* ---- small helpers --------------------------------------------------------------------------------------------- */

static void zero(void *p, u32 n)
{
    u32 *w = (u32 *)p, i;
    for (i = 0; i < n / 4; i++) ((volatile u32 *)w)[i] = 0;
}

static void copyw(void *to, const void *from, u32 n)
{
    u32 i;
    for (i = 0; i < n / 4; i++) ((volatile u32 *)to)[i] = ((const volatile u32 *)from)[i];
}

static void ev_copy(const struct ctx *c, const struct state *s, struct ev_log *e)
{
    e->n = s->ev_n; e->skip = s->ev_skip; e->crm = s->ev_crm; e->pb_n = s->pb_n; e->tick = s->timer ? c->tick(s->timer) : 0;
    copyw(e->ev, (const void *)s->ev_ring, sizeof e->ev);
    copyw(e->pb, (const void *)s->pb_ring, sizeof e->pb);
}

static void *timer_of(const struct ctx *c)
{
    u8 *h = c->timer_holder();
    return h ? (void *)rd32(h, 0xc) : 0;
}

static u32 cas(volatile u32 *p, u32 expect, u32 value)
{
    u32 old, fail;
    do {
        __asm__ volatile("ldrex %0, [%1]" : "=&r"(old) : "r"(p) : "memory");
        if (old != expect) { __asm__ volatile("clrex" ::: "memory"); return old; }
        __asm__ volatile("strex %0, %2, [%1]" : "=&r"(fail) : "r"(p), "r"(value) : "memory");
    } while (fail);
    __asm__ volatile("dmb" ::: "memory");
    return old;
}

static struct state *get_state(const struct ctx *c, u32 create)
{
    struct state *s = (struct state *)*(volatile u32 *)c->slot;
    if (s || !create) return s && s->magic == MAGIC_STATE ? s : 0;
    s = (struct state *)c->op_new(sizeof *s);
    if (!s) return 0;
    zero(s, sizeof *s);
    s->magic = MAGIC_STATE;
    s->timer = timer_of(c);
    s->nd_ev = 0x7fffffff;                  /* (mf17: the live view's EV not read yet) */
    if (cas((volatile u32 *)c->slot, 0, (u32)s) != 0) {      /* another task was first */
        c->op_delete(s);
        s = (struct state *)*(volatile u32 *)c->slot;
    }
    return s && s->magic == MAGIC_STATE ? s : 0;
}

static u32 us(const struct ctx *c, const struct state *s, u32 from, u32 to) { return c->elapsed(s->timer, from, to, 0); }

/* a probe's clock reading, and the microseconds between two (equal readings: 0; the stock elapsed-time function takes them
 * as a whole turn of the counter) */
static u32 now_p(const struct ctx *c, const struct state *s) { return c->tick_probe(s->timer); }
static u32 pus(const struct ctx *c, const struct state *s, u32 from, u32 to) { return from == to ? 0 : us(c, s, from, to); }

/* this core's number (MPIDR affinity level 0) */
static u32 core(void)
{
    u32 v;
    __asm__ volatile("mrc p15, 0, %0, c0, c0, 5" : "=r"(v));
    return v & 3u;
}

/* round(3 x) of a float given as bits (the camera's EXIF steps are thirds: ISO round(3 (Sv - 1)), shutter round(3 (Tv + 5)),
 * aperture round(3 Av)); 0x7fffffff when it is not a finite number of sensible size */
static s32 q3(u32 f)
{
    u32 e = (f >> 23) & 0xff, m = (f & 0x7fffff) | 0x800000;
    s32 sh = 150 - (s32)e, r;
    u64 v;
    if (e == 0) return 0;
    if (e == 0xff || sh < 0) return 0x7fffffff;
    if (sh > 40) return 0;
    v = (u64)m * 3u;
    if (sh > 0) v = (v + ((u64)1 << (sh - 1))) >> sh;
    if (v > 100000) return 0x7fffffff;
    r = (s32)v;
    return f >> 31 ? -r : r;
}

/* the frame's ISO step round(3 (Sv - 1)) (q3 of Sv is round(3 Sv), whole steps of 3 apart, so this is exact) */
static s32 iso_step(const u8 *si) { s32 v = q3(rd32(si, SI_SV)); return v == 0x7fffffff ? v : v - 3; }

/* round(k x) of a float given as bits (k <= 256), 0x7fffffff when not a finite number of sensible size (as q3) */
static s32 fxk(u32 f, u32 k)
{
    u32 e = (f >> 23) & 0xff, m = (f & 0x7fffff) | 0x800000;
    s32 sh = 150 - (s32)e, r;
    u64 v;
    if (e == 0) return 0;
    if (e == 0xff || sh < 0) return 0x7fffffff;
    if (sh > 40) return 0;
    v = (u64)m * k;
    if (sh > 0) v = (v + ((u64)1 << (sh - 1))) >> sh;
    if (v > 0x1000000) return 0x7fffffff;
    r = (s32)v;
    return f >> 31 ? -r : r;
}

/* EV100 x 256 = (Av + Tv - Sv + 5) x 256 of three APEX floats (Sv the nominal ISO: highlight correction does not change it) */
static s32 ev_of(u32 av, u32 tv, u32 sv)
{
    s32 a = fxk(av, 256), t = fxk(tv, 256), v = fxk(sv, 256);
    if (a == 0x7fffffff || t == 0x7fffffff || v == 0x7fffffff) return 0x7fffffff;
    return a + t - v + 5 * 256;
}
static s32 ev_si(const u8 *si) { return ev_of(rd32(si, SI_AV), rd32(si, SI_TV), rd32(si, SI_SV)); }

/* the gate (mf17): 1 the ISO step is at least ISO_GATE_STEP (mf13..16), 2 EV100 <= EV_GATE (dark at a low ISO, e.g. a slow
 * shutter), 3 both; 0: an ordinary single shot.  Under the user's usual settings (P, f/2.8, 1/60) the two are the same line */
static u32 gate_of(const u8 *si)
{
    s32 e = ev_si(si);
    return (iso_step(si) >= ISO_GATE_STEP ? 1u : 0u) | (e != 0x7fffffff && e <= EV_GATE ? 2u : 0u);
}

/* the float n / 8 (0 < n < 2^24) as bits */
static u32 f_eighths(s32 n)
{
    u32 v = (u32)n, b = 31;
    if (n <= 0) return 0;
    while (!(v >> b)) b--;
    return ((b + 127 - 3) << 23) | ((v << (23 - b)) & 0x7fffff);
}

static u32 isqrt64(u64 v)
{
    u64 r = 0, bit = (u64)1 << 62;
    while (bit > v) bit >>= 2;
    while (bit) {
        if (v >= r + bit) { v -= r + bit; r = (r >> 1) + bit; } else r >>= 1;
        bit >>= 2;
    }
    return (u32)r;
}

/* ref.noise_table with lam_s = ns_a[n] / (K 2^16), lam_r = ns_b / (K 2^16), K = 1024^2 / pi:
 * entry = max(1, round(sqrt(K * var))), var = (lam_s * min(x, 1) + lam_r) * rng^2, x = bin centre / rng */
static s32 noise_table(const struct ctx *c, s32 n, s32 black, s32 white, s32 *tab)
{
    u32 rng = (u32)(white - black), a = c->ns_a[n - NS_FIRST], b, shift = 0, t;
    while ((1u << (shift + 8)) < rng) shift++;              /* bit_length(rng - 1) - 8, at least 0 */
    for (b = 0; b < MF_NOISE_BINS; b++) {
        u32 centre = (b << shift) + ((1u << shift) >> 1), mc = centre < rng ? centre : rng;
        u64 v = (u64)a * rng * mc + (u64)c->ns_b * rng * rng;
        t = (isqrt64(v) + 128) >> 8;
        tab[b] = t ? (s32)t : 1;
    }
    return (s32)shift;
}

/* spec v9 (ref.weights_noise_table): entry = max(1, (isqrt(A * min(bin centre, rng) + B) + 128) >> 8), A, B of ISO step n
 * (u64; A * mc + B < 2^64 for every step and rng <= 65535); the same shift as noise_table */
static s32 weights_table(const struct ctx *c, s32 n, s32 black, s32 white, s32 *tab, struct mf_log *g)
{
    const u32 *w = c->ws + 4 * (u32)(n - NS_FIRST);
    u64 a = (u64)w[0] | (u64)w[1] << 32, b = (u64)w[2] | (u64)w[3] << 32;
    u32 rng = (u32)(white - black), shift = 0, i, t;
    while ((1u << (shift + 8)) < rng) shift++;
    g->w_a[0] = w[0]; g->w_a[1] = w[1]; g->w_b[0] = w[2]; g->w_b[1] = w[3];
    for (i = 0; i < MF_NOISE_BINS; i++) {
        u32 centre = (i << shift) + ((1u << shift) >> 1), mc = centre < rng ? centre : rng;
        t = (isqrt64(a * mc + b) + 128) >> 8;
        tab[i] = t ? (s32)t : 1;
    }
    return (s32)shift;
}

/* ---- hold instead of copy (mf13) ---------------------------------------------------------------------------------
 * Slot protocol (struct hslot, shared with the Free stubs of handnight.ts; the stubs may run in any task on any core).  The
 * slot is one word, allocation address | state (addresses are 4-byte aligned), so address and state change together:
 *   register (this task, module 9 of frames 1..3): slot 0 (EMPTY), site / dup cleared, then word = raw | HELD (seq_cst store);
 *   the hook at the entry of the pool free method 0x53905DB0 (every IMAGE free, any task; handnight.ts installHoldFreeHook),
 *   called from anywhere but the relocation: for a slot whose address equals the freed pointer, ldrex/strex
 *     raw | HELD -> raw | RELEASED, then the Free is skipped (r0 = 1, "freeOk", what the stock Free returns on success);
 *     raw | RELEASED already -> skipped too (a repeated free of a block that is ours now, counted in dup); otherwise the
 *     stock Free.  LDREX / STREX, not interrupts off: the stubs and this task may run on different cores of the 3-core
 *     kernel at the same instant; masking interrupts on one core would not order the other cores;
 *   called from the relocation (return address 0x5374AAE4: the stock copied the block elsewhere and frees the old one): raw | HELD -> DROPPED (3,
 *     no address), then the stock Free;
 *   resolve (this task, every way out of the group, and alternates not used): word exchanged with 0; RELEASED: Free here;
 *     HELD: nothing (the stock frees it later, its stub then finds no slot); DROPPED: nothing.
 * Each block is freed exactly once in every order: the exchange and the strex on the one word decide who frees it. */
static void hold_resolve(const struct ctx *c, struct state *s, u32 k)
{
    struct hslot *h = &s->hold[k];
    struct hold_log *L = &s->log.hold[k];
    u32 w = __atomic_exchange_n(&h->word, 0u, __ATOMIC_SEQ_CST), x = w & 3u, raw = w & ~3u;
    if (!w) return;
    L->site = h->site; L->dup = h->dup; L->caller = h->caller;
    if (x == H_RELEASED && raw) { c->img_free(c->img(), (void *)raw); s->hold_frees++; L->final = 1; }
    else L->final = x == H_HELD ? 2 : 3;
    s->hpx[k] = 0;
}

static void free_all(const struct ctx *c, struct state *s)
{
    void *a = c->img();
    u32 k;
    for (k = 0; k < GROUP - 1; k++) hold_resolve(c, s, k);
    for (k = 0; k < MF_PARTS; k++) {
        if (s->blk[k]) c->img_free(a, s->blk[k]);
        s->blk[k] = 0;
    }
}

/* the canary: a checksum of CANARY_ROWS whole rows (after a clean + invalidate of them) */
static void sync(const struct ctx *c, const void *p, u32 n);
static u32 canary(const struct ctx *c, const u16 *img, u32 w, u32 h)
{
    u32 j, x, v = 0x811c9dc5u;
    for (j = 1; j <= CANARY_ROWS; j++) {
        const u16 *r = img + ((h * j / (CANARY_ROWS + 1)) & ~1u) * w;
        sync(c, r, 2 * w);
        for (x = 0; x < w; x++) v = (v ^ r[x]) * 0x01000193u;
    }
    return v;
}

static void sample(const struct ctx *c, const u16 *img, u32 w, u32 h, u16 *px, u32 flush);

/* the held frame k unchanged since its registration (32 pixels and the row checksum) */
static u32 canary_ok(const struct ctx *c, struct state *s, u32 k)
{
    u16 px[32];
    u32 i;
    sample(c, (const u16 *)s->hpx[k], s->width, s->height, px, 1);
    for (i = 0; i < 32; i++) if (px[i] != s->hsample[k][i]) return 0;
    return canary(c, (const u16 *)s->hpx[k], s->width, s->height) == s->canary[k];
}

static u32 hold_state(struct state *s, u32 k) { return __atomic_load_n(&s->hold[k].word, __ATOMIC_SEQ_CST) & 3u; }

/* the held block was never really freed: its slot still HELD or RELEASED (every pool free passes the hook, which never lets a
 * HELD block go but at the relocation, where it drops the slot) and the pool's block header [raw - 8] unchanged (the pool's free
 * method 0x53905DB0 clears it, 0x53905E5C) */
static u32 still_ours(struct state *s, u32 k)
{
    u32 st = hold_state(s, k);
    return (st == H_HELD || st == H_RELEASED) && rd32((const void *)(s->log.hold[k].raw - 8), 0) == s->hdr[k];
}
static u32 hold_raw(struct state *s, u32 k) { return __atomic_load_n(&s->hold[k].word, __ATOMIC_SEQ_CST) & ~3u; }

/* the 6 recipes of the pool, compactly (log version 11; read only, racy by nature: the other tasks keep running) */
static u32 dump_recipes(u32 *out)
{
    const u64 ids = 0x1809070604030201ull;   /* ids 1 2 3 4 6 7 9 24 (no data section: a constant) */
    u32 k, i, n = 0;
    for (k = 0; k < REC_N; k++) {
        const u8 *r = (const u8 *)(REC_POOL + k * REC_STRIDE);
        u32 *o = out + k * REC_WORDS, vt = rd32(r, 0), dm = 0, am = 0, sz = 0;
        if (vt < 0x53000000u || vt >= 0x55000000u) continue;
        n++;
        o[0] = (rd32(r, 0x14) & 0xffffu) | (u32)rd8(r, 0x12) << 16 | (u32)rd8(r, 0xf) << 24;
        o[1] = rd32(r, 0x18);
        for (i = 0; i < 25; i++) {
            if (rd8(r, 0x338 + i)) dm |= 1u << i;
            if (rd32(r, 0x354 + 4 * i)) { am |= 1u << i; sz += rd32(r, 0x3b8 + 4 * i); }
        }
        o[2] = dm; o[3] = am; o[4] = sz;
        for (i = 0; i < 8; i++) {
            u32 id = (u32)(ids >> (8 * i)) & 0xffu;
            o[5 + 2 * i] = rd32(r, 0x354 + 4 * id); o[6 + 2 * i] = rd32(r, 0x3b8 + 4 * id);
        }
    }
    return n;
}

/* C:\M<kind>xxxxxx.BIN (xxxxxx: tick >> 8 in hex) with the file service, from the back end task; 1 if written */
static u32 write_file(const struct ctx *c, char kind, u32 tick, const void *data, u32 bytes)
{
    char name[16];
    u32 i, v = tick >> 8, handle = 0;
    u8 *holder, *fs;
    name[0] = 'C'; name[1] = ':'; name[2] = '\\'; name[3] = 'M'; name[4] = kind;
    for (i = 0; i < 6; i++) {
        u32 d = (v >> (20 - 4 * i)) & 15;
        name[5 + i] = (char)(d < 10 ? '0' + d : 'A' + d - 10);
    }
    name[11] = '.'; name[12] = 'B'; name[13] = 'I'; name[14] = 'N'; name[15] = 0;
    holder = c->file_holder();
    fs = holder ? (u8 *)rd32(holder, 0x14) : 0;
    if (!fs) return 0;
    {
        const u8 *vt = (const u8 *)rd32(fs, 0);
        u32 (*open)(u8 *, const char *, u32, u32 *, u32) = (u32 (*)(u8 *, const char *, u32, u32 *, u32))rd32(vt, 0x20);
        u32 (*write)(u8 *, u32, const void *, u32, u32) = (u32 (*)(u8 *, u32, const void *, u32, u32))rd32(vt, 0x2c);
        u32 (*close)(u8 *, u32, u32) = (u32 (*)(u8 *, u32, u32))rd32(vt, 0x24);
        if (!open(fs, name, 0, &handle, 0)) return 0;
        write(fs, handle, data, bytes, 0);
        close(fs, handle, 0);
    }
    return 1;
}

#define BF_SHUTDOWN 1u
#define BF_HIDE 2u
#define BF_PRESS 4u
#define BF_NR 8u
#define BF_WB 16u
#define BF_DRIVE 32u
#define BF_LIMITS 64u
#define BF_TONE 128u
#define BF_REVIEW 256u
#define BF_TONECAP 512u
#define BF_EVLOG 1024u
#define BF_ASN 2048u
#define BF_WATCH 4096u
#define BF_WBV2 8192u
#define BF_DCAP 16384u
#define BF_TONEMENU 32768u
#define BF_OSD 65536u
#define BF_REND 131072u
#define BF_NREVIEW 262144u
#define BF_PROC 524288u
#define BF_LOGDEFER 1048576u
#define BF_PROBES 2097152u
#define BF_KEEP 4194304u
#define BF_PBAR 8388608u
#define BUILD_FLAGS ((SHUTDOWN_STOP ? BF_SHUTDOWN : 0) | (HIDE_EARLY ? BF_HIDE : 0) | (PRESS_LOG ? BF_PRESS : 0) | (NR_AUTO ? BF_NR : 0) | \
                     (WB_FIRST ? BF_WB : 0) | (NIGHT_DRIVE ? BF_DRIVE : 0) | (NIGHT_LIMITS ? BF_LIMITS : 0) | (TONE_HOOK ? BF_TONE : 0) | \
                     (REVIEW_ARM ? BF_REVIEW : 0) | (TONE_MAX_Q8 > 0 ? BF_TONECAP : 0) | \
                     (EV_LOG ? BF_EVLOG : 0) | (ASN_FIRST ? BF_ASN : 0) | (RV_WATCH ? BF_WATCH : 0) | \
                     (WB_FIRST_V2 ? BF_WBV2 : 0) | (TONE_DMAX_Q8 > 0 ? BF_DCAP : 0) | (TONE_MENU ? BF_TONEMENU : 0) | \
                     (OSD_UNHIDE ? BF_OSD : 0) | (REVIEW_END ? BF_REND : 0) | (NIGHT_REVIEW ? BF_NREVIEW : 0) | \
                     (PROC_SCREEN ? BF_PROC : 0) | (LOG_DEFER ? BF_LOGDEFER : 0) | \
                     (PROBES ? BF_PROBES : 0) | (KEEP_LAST_ONLY ? BF_KEEP : 0) | (PROGRESS_BAR ? BF_PBAR : 0))

static void write_log(const struct ctx *c, struct state *s)
{
    u32 i;
    struct mf_log *g = &s->log;
    u32 t0 = now_p(c, s);
    g->magic = LOG_MAGIC; g->version = VERSION; g->bytes = sizeof *g;
    g->build_flags = BUILD_FLAGS; g->ev_gate = EV_GATE; g->press_files = s->press_files; g->ui_ticks = s->ui_ticks;
    g->nd_switches = s->nd_switches; g->nd_ev = s->nd_ev;
    g->rv_win_us = REVIEW_ARM ? REVIEW_WATCH_US : 0; g->shutter_word = rd32((const void *)SHUTTER_SITE, 0);
    copyw(&g->rv, &s->rv, sizeof g->rv);
    copyw(&g->dv, &s->dv, sizeof g->dv);
#if PROBES
    g->rd_n = s->rd_n; copyw(g->rd, s->rd, sizeof g->rd);
#endif
    if (EV_LOG) ev_copy(c, s, &g->evl);
    g->mem_gate_bytes = MEM_GATE_BYTES; g->mem_gated = s->mem_gated; g->mem_skipped = s->mem_skipped; g->mem_total_last = s->mem_total_last;
    s->mem_gated = s->mem_skipped = 0;
    g->h1_seq = s->h1_seq;
    for (i = 0; i < H1_RING; i++) { g->h1[i] = s->h1[i]; g->h1_iso[i] = s->h1_iso[i]; }
    g->h2_limit_us = TAP_LIMIT_US; g->h2_seq = s->h2_seq; g->h2_cont = s->h2_cont;           /* (tap block) */
    for (i = 0; i < H2_RING; i++) g->h2[i] = s->h2[i];
    g->prev_log_us = s->prev_log_us;
    g->wakes = s->wakes;
    g->ui_draws = s->ui_draws; g->ui_first = s->ui_first; g->ui_last = s->ui_last; g->ui_max_gap = s->ui_max_gap;
    g->ui_vt_fail = s->ui_vt_fail; g->ui_core = s->ui_core;
    g->ui_calls = s->ui_calls; g->ui_nsamples = s->ui_nsamples;
    for (i = 0; i < 8; i++) { g->ui_samples[i][0] = s->ui_samples[i][0]; g->ui_samples[i][1] = s->ui_samples[i][1]; g->ui_samples[i][2] = s->ui_samples[i][2]; }
    g->lv_prev_ui = __atomic_exchange_n(&s->lv_ui_net, 0u, __ATOMIC_SEQ_CST);
    g->hold_frees = s->hold_frees; s->hold_frees = 0;
    g->files = s->files;
    for (i = 0; i < 6; i++) g->pmin[i] = s->pmin[i];
    s->pmin[0] = s->pmin[1] = s->pmin[3] = s->pmin[4] = 0xffffffffu; s->pmin[2] = s->pmin[5] = 0;
    for (i = 0; i < GROUP - 1; i++) g->keep[i] = s->kp_res[i];
    g->keep_flags = (KEEP_LAST_ONLY ? 1u : 0) | (PROBES ? 2u : 0) | (PROGRESS_BAR ? 4u : 0);
    if (PROBES) {
        if (write_file(c, 'F', g->f[0].tick, g, sizeof *g)) {
            s->files++;
            s->prev_log_us = pus(c, s, t0, now_p(c, s));
        }
    } else if (c->log_sink) { c->log_sink('F', g->f[0].tick, g, sizeof *g); s->files++; }   /* (the emulator only) */
}

/* the group's log now, if it waits for the merged frame's module 7 (any other way the log would be lost or overwritten) */
static void flush_log(const struct ctx *c, struct state *s)
{
    if (!s->log_due) return;
    s->log_due = 0;
    write_log(c, s);
}

static void prefetch_back(u32 found);
static void pool(const struct ctx *c, u32 which, u32 *total, u32 *largest);
static void keep_arm(struct state *s, u32 result);

/* at a group's start: what came after the previous group (log version 11; the tasks that wrote it ran after that group's log
 * was written): the re-posted start's return, the App's Start, the UI samples; their window ends here */
static void take_prev(const struct ctx *c, struct state *s, struct mf_log *g)
{
    u32 st, at, n, i;
    __atomic_store_n(&s->post_on, 0u, __ATOMIC_SEQ_CST);
    __atomic_store_n(&s->app_req, 0u, __ATOMIC_SEQ_CST);
    st = __atomic_exchange_n(&s->lv_start_ret, 0u, __ATOMIC_SEQ_CST); at = 0; n = s->post_n;   /* (mf14: no App call after the group) */
    g->prev_lv_start_ret = st;
    g->prev_lv_start_us = st && s->lv_post_tick ? pus(c, s, s->lv_post_tick, s->lv_start_tick) : 0;
    g->prev_app_ret = at;
    g->prev_fb_ret = __atomic_exchange_n(&s->fb_ret, 0u, __ATOMIC_SEQ_CST);
    g->prev_fb_us = g->prev_fb_ret && s->post_t0 ? pus(c, s, s->post_t0, s->fb_tick) : 0;
    g->review_stop = REVIEW_STOP;
    g->prev_app_us = at && s->post_t0 ? pus(c, s, s->post_t0, s->app_tick) : 0;
    if (n > POST_SAMPLES) n = POST_SAMPLES;
    g->prev_post_n = n;
    for (i = 0; i < n; i++) { g->prev_post[i][0] = s->post[i][0]; g->prev_post[i][1] = s->post[i][1]; g->prev_post[i][2] = s->post[i][2]; }
    s->app_ret = 0; s->post_n = 0; s->lv_post_tick = 0;
    __atomic_store_n(&s->lv_watch, 0u, __ATOMIC_SEQ_CST);
    __atomic_store_n(&s->rv_req, 0u, __ATOMIC_SEQ_CST);           /* mf18: the review watch of the previous group ends here */
    s->rv.on = 0;
    copyw(&g->prev_rv, &s->rv, sizeof g->prev_rv);
    zero(&s->rv, sizeof s->rv);
    copyw(&g->prev_dv, &s->dv, sizeof g->prev_dv);           /* mf21 (the UI task owns s->dv; a racy copy, for the log only) */
}

/* ---- live view off during the merge (log version 10) ---------------------------------------------------------------
 * A/B: the front end numbers the groups it lets start (frame 1, gates passed); even numbers are A.  At frame 4 of an A
 * group (its stop decision, step 0x31D, which comes before the burst's last live-view restarts: plan 2's 0x30D and plan 3's
 * 0x405) it sets lv_armed.  While lv_armed is set the StartLiveView hook (handnight.ts, task LiveViewCtrl) skips the start
 * and sets lv_deferred.  On every end of that group (merged, time limit, error, memory, exposure, short, switch off, ...)
 * lv_release clears lv_armed and takes lv_deferred back (atomic exchange; the hook re-checks lv_armed after setting it, so a
 * start is either skipped and re-posted here, or not skipped); if a start was skipped and live view is not running again
 * already (a stock start: mode dial, playback, menu, leaving the review), the restart message is posted once, as the
 * front end's shutdown preparation does (retried once if the post returns a negative code).  The UI task's watchdog
 * (handnight.ts) does the same if a deferral outlives LIMIT_US + 5 s with no merge running. */
/* mf17: the shutdown preparation has stopped live view (its VIEW_STOP sets LiveViewControl +0xE3, 0x536535EC; cleared by a
 * cancel 0x68C40806); the object is noted by the StartLiveView hook at every start */
static u32 shutdown(const struct state *s)
{
    const u8 *lvc = (const u8 *)s->lv_obj;
    return SHUTDOWN_STOP && ram(lvc) && rd8(lvc, LVC_SHUT);
}

/* the front end's plan entries in use: bit i for entry i of the 6 ([SEQ+0x90], 0x1A50 bytes each, +0x20; read only);
 * 0x100: no sequencer noted */
static u32 fe_plans(const struct state *s)
{
    const u8 *seq = (const u8 *)s->lv_seq, *e;
    u32 i, m = 0;
    if (!ram(seq)) return 0x100;
    e = (const u8 *)rd32(seq, 0x90);
    if (!ram(e)) return 0x100;
    for (i = 0; i < 6; i++) if (rd8(e, i * 0x1a50 + 0x20)) m |= 1u << i;
    return m;
}

static void lv_release(const struct ctx *c, struct state *s)
{
    struct mf_log *g = &s->log;
    u8 *lvc, *seq;
    u32 msg[7], i;
    s32 r, r2 = 0;
    __atomic_store_n(&s->lv_armed, 0u, __ATOMIC_SEQ_CST);
    if (!__atomic_exchange_n(&s->lv_deferred, 0u, __ATOMIC_SEQ_CST)) return;
    g->lv_skips = s->lv_skips;
    g->lv_defer_us = pus(c, s, s->lv_arm_tick, now_p(c, s));
    lvc = (u8 *)s->lv_obj; seq = (u8 *)s->lv_seq;
    if (shutdown(s)) { g->lv_net = LV_NET_SHUT | LV_NET_BE; return; }         /* never a restart while the camera shuts down */
    if (ram(lvc) && rd8(lvc, LV_RUNNING)) { g->lv_net = LV_NET_STOCK | LV_NET_BE; return; }
    if (s->h2_seq != s->arm_h2 && (fe_plans(s) & 0x3f)) { g->lv_net = LV_NET_PRESS | LV_NET_BE; return; }
    g->lv_net = LV_NET_BE;
    if (!ram(seq)) { g->lv_post_ret = 0xffffffffu; return; }
    for (i = 0; i < 7; i++) msg[i] = 0;
    msg[0] = LV_RESTART;
    s->lv_post_tick = now_p(c, s);
    __atomic_store_n(&s->lv_watch, 1u, __ATOMIC_SEQ_CST);       /* the StartLiveView hook notes the return of the start it causes */
    r = c->fe_post(seq + 0x10, msg);
    if (r < 0) {
        for (i = 0; i < 7; i++) msg[i] = 0;
        msg[0] = LV_RESTART;
        r2 = c->fe_post(seq + 0x10, msg);
    }
    g->lv_post_ret = ((u32)r & 0xffffu) | ((u32)r2 << 16);
}

/* the group is over: everything goes back, the log is written; later frames of the same burst are a tail */
static void end_group(const struct ctx *c, struct state *s, u32 result, u32 tail)
{
    u32 was = s->phase, down;
    __atomic_store_n(&s->app_req, 0u, __ATOMIC_SEQ_CST);      /* no review stop after the merge (the stock flow ends it then) */
    s->log.rv_ret = s->app_ret; s->log.rv_us = s->app_ret && s->merge_tick ? pus(c, s, s->merge_tick, s->app_tick) : 0;
    s->app_ret = 0;
    free_all(c, s);
    {                                                       /* mf17: the state at the end */
        const u8 *lvc = (const u8 *)s->lv_obj;
        s->log.lv_e3 = ram(lvc) ? (u32)rd8(lvc, LVC_SHUT) | (u32)rd8(lvc, LV_RUNNING) << 8 : 0xffffu;
        s->log.fe_plans = fe_plans(s); s->log.arm_h2 = s->arm_h2; s->log.h2_end = s->h2_seq;
    }
    down = shutdown(s);
    if (down) s->log.shut |= 2;
    if (s->lv_armed && s->lv_armed == s->group_burst) lv_release(c, s);      /* live view back (never while shutting down) */
    s->active = 0;
    s->last_end_tick = c->tick(s->timer);
    if (was == 1 && down) { s->log_due = 0; s->eq_recipe = 0; s->eq_nr = 0; if (KEEP_LAST_ONLY) keep_arm(s, R_SHUTDOWN); }   /* power off: no file, nothing after it */
    else if (was == 1) {
        if (KEEP_LAST_ONLY) keep_arm(s, result);                   /* (before the log: its keep words) */
        pool(c, 0, &s->log.pools_end[0], &s->log.pools_end[1]); pool(c, 1, &s->log.pools_end[2], &s->log.pools_end[3]);
        s->log.result = result;
        if (result == R_MERGED && s->eq_recipe) { s->log_due = 1; s->log_due_tick = s->last_end_tick; }   /* at its module 7 */
        else write_log(c, s);
        /* the UI task samples the screen and live view for 5 s from here (its words go into the next group's log) */
        s->post_n = 0; s->post_last = 0; s->post_t0 = now_p(c, s);
        __atomic_store_n(&s->fb_ret, 0u, __ATOMIC_SEQ_CST);               /* the UI fallback of this window (mf16) */
        __atomic_store_n(&s->post_on, PROBES && s->post_t0 ? 1u : 0u, __ATOMIC_SEQ_CST);   /* (mf24: samples only in the recording build) */
        /* mf18: a merged group's review is armed by the UI task at its next loop (rv_tick) */
        if ((REVIEW_ARM || RV_WATCH) && result == R_MERGED && s->post_t0) { s->rv_t0 = s->post_t0; __atomic_store_n(&s->rv_req, 1u, __ATOMIC_SEQ_CST); }
        /* mf21: the UI task's display window after every group (D guards, REVIEW_END, samples) */
        if (s->post_t0) { s->dv_t0 = s->post_t0; __atomic_store_n(&s->dv_rel, 0u, __ATOMIC_SEQ_CST); __atomic_store_n(&s->dv_req, result | 0x100u, __ATOMIC_SEQ_CST); }
    }
    s->count = 0;
    s->phase = tail ? 2 : 0;
}

static void pool(const struct ctx *c, u32 which, u32 *total, u32 *largest)
{
    void *a = c->img();
    u32 t = 0, l = 0;
    if (a) c->img_free_size(a, &t, &l, which);
    *total = t; *largest = l;
}

/* `size` bytes from pool `which` (0 IMAGE1, 1 IMAGE2), kept only if the pool's largest free block is then at least
 * `keep`; 0 otherwise (nothing is held) */
static u8 *take(const struct ctx *c, u32 size, u32 which, u32 keep, u32 *after)
{
    void *a = c->img();
    u32 t, l;
    u8 *p;
    if (after) *after = 0;
    if (!a) return 0;
    pool(c, which, &t, &l);
    if (l <= size) return 0;                 /* Alloc would refuse */
    p = (u8 *)c->img_alloc(a, size, which);
    if (!p) return 0;
    pool(c, which, &t, &l);
    if (after) *after = l;
    if (l < keep) { c->img_free(a, p); return 0; }
    return p;
}

/* Clean + invalidate, before reading a frame (the hardware wrote it, PIX_CORR(SW) may have dirty lines in it) and after
 * writing one (RAW_CODEC reads it with the hardware). */
static void sync(const struct ctx *c, const void *p, u32 n)
{
    void *k = c->cache();
    u32 a = (u32)p & ~63u, b = ((u32)p + n + 63) & ~63u;
    c->flush(k, a, b - a);
}

/* 16 pixels from (40, 40) and 16 from the middle, to compare with the frame's DNG (origin and row length) */
static void sample(const struct ctx *c, const u16 *img, u32 w, u32 h, u16 *px, u32 flush)
{
    const u16 *a = img + 40 * w + 40, *b = img + ((h / 2) & ~1u) * w + ((w / 2) & ~1u);
    u32 i;
    if (flush) { sync(c, a, 32); sync(c, b, 32); }
    for (i = 0; i < 16; i++) { px[i] = a[i]; px[16 + i] = b[i]; }
}

/* lowest free memory over the module calls of the burst frames (what the stock steps after module 9 leave) */
static void track(const struct ctx *c, struct state *s, u32 module)
{
    u32 t, l;
    if (!s->pmin[5]) { s->pmin[0] = s->pmin[1] = s->pmin[3] = s->pmin[4] = 0xffffffffu; }
    pool(c, 0, &t, &l);
    if (t < s->pmin[0]) s->pmin[0] = t;
    if (l < s->pmin[1]) { s->pmin[1] = l; s->pmin[2] = module; }
    pool(c, 1, &t, &l);
    if (t < s->pmin[3]) s->pmin[3] = t;
    if (l < s->pmin[4]) s->pmin[4] = l;
    s->pmin[5]++;
}

/* (mf14: the once-per-power-on copy benchmark bench[] is gone: it needed one 32 MB destination block; bench[] stays 0) */

/* The hardware data prefetcher (ACTLR bits 14:13) during the merge.  The boot code clears them on every core; the camera
 * run of 2026-11-21 measured a streaming copy 2.5 times as fast with them set, and ACTLR writable from this task (read back
 * 0x6040).  They are set right before mf_merge_ex, set again at each stop check (and by a worker after each job, mf15) if
 * clear on the core the task is on then,
 * and put back to what was found right after mf_merge_ex returns, on the core the task is on then.  A core the task visited
 * in between may keep the prefetcher on until power-off; as far as known this is harmless (why the boot code switches it
 * off is not known). */
static u32 actlr_get(void)
{
    u32 v;
    __asm__ volatile("mrc p15, 0, %0, c1, c0, 1" : "=r"(v));
    return v;
}

static void actlr_put(u32 v) { __asm__ volatile("mcr p15, 0, %0, c1, c0, 1\n isb" :: "r"(v) : "memory"); }

static void prefetch_on(void)
{
    u32 v = actlr_get();
    if ((v & L1PCTL) != L1PCTL) actlr_put(v | L1PCTL);
}

/* only bits 14:13 are put back: the other bits stay as this core has them */
static void prefetch_back(u32 found)
{
    u32 v = actlr_get(), w = (v & ~L1PCTL) | (found & L1PCTL);
    if (w != v) actlr_put(w);
}

struct stopper { const struct ctx *c; struct state *s; struct mf_par *par; u32 n, nstrips; };

/* ---- the waiting indicator -------------------------------------------------------------------------------------- */

/* the spinner's next step (never 0 while shown), and the UI task woken: the application's callback-only event, no callback */
static void post_wake(const struct ctx *c, struct state *s)
{
    void *q = c->app_queue();
    __atomic_fetch_add(&s->wakes, 1u, __ATOMIC_RELAXED);
    if (q) c->app_post(q, EV_CALLBACK, 0, 0);
}

static void wake(const struct ctx *c, struct state *s, u32 busy, u32 now)
{
    __atomic_store_n(&s->busy, busy, __ATOMIC_SEQ_CST);
    s->wake_tick = now;
    post_wake(c, s);
}

/* the next step: busy + 1 (never 0); the workers may add too (try_wake) */
static void show(const struct ctx *c, struct state *s, u32 now)
{
    if (!__atomic_add_fetch(&s->busy, 1u, __ATOMIC_SEQ_CST)) __atomic_store_n(&s->busy, 1u, __ATOMIC_SEQ_CST);
    s->wake_tick = now;
    post_wake(c, s);
}

/* any thread after a job: one wake-up per WAKE_US overall (the clock reading that wins the exchange posts it) */
static void try_wake(const struct ctx *c, struct state *s)
{
    u32 old = __atomic_load_n(&s->wake_tick, __ATOMIC_RELAXED), now = now_p(c, s);
    if (!__atomic_load_n(&s->busy, __ATOMIC_RELAXED) || pus(c, s, old, now) < WAKE_US) return;
    if (!__atomic_compare_exchange_n(&s->wake_tick, &old, now, 0, __ATOMIC_SEQ_CST, __ATOMIC_RELAXED)) return;
    if (!__atomic_add_fetch(&s->busy, 1u, __ATOMIC_SEQ_CST)) __atomic_store_n(&s->busy, 1u, __ATOMIC_SEQ_CST);
    post_wake(c, s);
}

static void hide(const struct ctx *c, struct state *s)
{
    s->progress = 0;
    if (s->shut || shutdown(s)) { __atomic_store_n(&s->busy, 0u, __ATOMIC_SEQ_CST); return; }   /* power off: no UI event (mf17) */
    wake(c, s, 0, c->tick(s->timer));
}

/* the indicator's percent after stop check `at`: alternate `at` aligned (at < MF_MAX_FRAMES; PHASE1_SHARE % over the n
 * alternates), or strips finished in phase 2 over all threads (the rest); shown as round(100 t^1.3), never down, 99 at most
 * until the merged frame is written back (then 101 = 100 % + 1, merge_run) */
static void show_pct(struct state *s, const struct ctx *c, u32 t)
{
    u32 v = c->shown[t > 100 ? 100 : t];
    if (v > 99) v = 99;
    if (v < s->shown_max) v = s->shown_max;
    s->shown_max = v;
    s->progress = v + 1;
}

static void progress(struct stopper *q, s32 at)
{
    struct state *s = q->s;
    u32 t, n = q->n ? q->n : 1, k;
    if (at < MF_MAX_FRAMES) { k = (u32)at + 1; t = PHASE1_SHARE * (k < n ? k : n) / n; }
    else {
        k = q->par ? __atomic_load_n(&q->par->strips_done, __ATOMIC_RELAXED) : (u32)(at - MF_MAX_FRAMES) + 1;
        if (k > q->nstrips) k = q->nstrips;
        t = PHASE1_SHARE + (P_MERGED - PHASE1_SHARE) * k / (q->nstrips ? q->nstrips : 1);
    }
    show_pct(s, q->c, t);
}

/* phase 1 between two alternates: the share of the alternate in progress from the rounds of jobs handed out since the last
 * one was aligned, against the rounds the aligned ones took (P1_ROUNDS before the first), at most 9/10 of it */
static void progress_rounds(struct stopper *q)
{
    struct state *s = q->s;
    u32 n = q->n ? q->n : 1, z = s->p1_alts, est, f;
    if (z >= n) return;
    est = z ? s->p1_r_last / z : P1_ROUNDS;
    if (!est) est = 1;
    f = (s->p1_rounds - s->p1_r_last) * 1000u / est;
    if (f > 900) f = 900;
    show_pct(s, q->c, PHASE1_SHARE * (z * 1000u + f) / (n * 1000u));
}

static s32 stop_check(void *p, s32 at)
{
    struct stopper *q = (struct stopper *)p;
    u32 now = q->c->tick(q->s->timer), t = us(q->c, q->s, q->s->merge_tick, now);
    if (at < MF_MAX_FRAMES - 1 && at >= 0) q->s->log.align_us[at] = t;
    q->s->log.core_checks[core()]++;
    if (shutdown(q->s)) { q->s->shut = 1; q->s->log.shut |= 1; q->s->log.stop_at = (u32)at + 1; return 1; }   /* power key (mf17) */
    if (t > LIMIT_US) { q->s->log.stop_at = (u32)at + 1; return 1; }
    if (at >= 0 && at < MF_MAX_FRAMES) { q->s->p1_alts = (u32)at + 1; q->s->p1_r_last = q->s->p1_rounds; }
    if (at >= 0) progress(q, at);
    if (at == (s32)q->n - 1) { q->s->mt_phase2 = 1; q->s->log.t_p2_us = t; }   /* the last alternate: crew jobs are phase 2 from here on */
    if (us(q->c, q->s, q->s->wake_tick, now) >= WAKE_US) show(q->c, q->s, now);
    prefetch_on();                           /* the task may be on another core now */
    return 0;
}

/* ---- the merge on three cores (log version 7) ----------------------------------------------------------------------
 * mf_merge_mt hands its jobs (mf_core.h) to this task (slot 0) and to MT_WORKERS worker tasks made for the merge with the
 * kernel's own calls (ctx; SMP T-Kernel, the research notes "T7e"): attribute 0x00021003 and processor mask 7 as
 * every stock task (TA_COP0: the kernel saves the NEON registers per task; the scheduler puts them on any of cores 0..2),
 * priority MT_PRI, a stack of MT_STACK bytes that the kernel allocates (and frees at tk_exd_tsk).
 *   round (crew_run): the jobs go to a shared counter; every worker's "go" semaphore is signalled, this task takes jobs
 *     too, then waits for one "done" signal per signalled worker.  A worker sets the prefetch bits on its core, takes
 *     jobs until none is left and signals "done".
 *   end (crew_stop, after every outcome of the merge, and when setting up fails half-way): quit is set and every go
 *     signalled; each worker puts back the ACTLR prefetch bits it found when it started (on the core it is on then),
 *     counts itself gone (its last access to the crew), signals done and exits with tk_exd_tsk.  This task waits for
 *     those signals, deletes the go semaphores (a worker still waiting on one is released with E_DLT and exits the same
 *     way, without the signal), waits until every worker is gone and deletes "done".  Nothing is left behind.
 *   Any kernel call failing while setting up: what was made is undone and the merge runs on this task alone; the first
 *     failure is logged (mt_fail_step / mt_fail_code).  A failing call during the merge: the rest runs on this task. */
#define MT_WORKERS 2u
/* Worker priority.  mf10 (96, below every stock task) left the workers starved on the camera: one 20 s phase-2 job, 75 MB/s
 * against 342 MB/s for this task.  84: below the UI (AppMain 82, ScreenLcd / TouchPanelLcd 80, PlaybackVsyncHandler 81), live
 * view (68..80) and DisplayPort / HdmiMonitor (83); equal to AeLiveViewCalc and the codec / store macro processes (84); above
 * storage (85..87), FaceDetect (88), AF / AE / log (93..95).  Not 83: this kernel never sets a time slice (tk_chg_slt 0x53067478
 * is called only by two wrappers that nothing calls), so tasks of one priority run first come, first served until they block, and a worker
 * at 83 would keep DisplayPort off its core for a whole round.  At 84 the same holds for the 84 tasks, so a worker gives way
 * after every job (tk_rot_rdq(84), as the stock code does in its one polling loop at 0x537A488C). */
#define MT_PRI 84
#define MT_STACK 4096                    /* deepest worker stack measured in the emulator about 600 bytes (test_be.py, test_big.py
                                            check < MT_STACK / 2); x 2 = 1.2 KB, rounded up to the smallest stock stack */
#define MT_ATR 0x00021003u               /* TA_HLNG | 2 | TA_COP0 | TA_ASSPRC, as every stock task (CreateTask 0x5390ACF0) */
#define MT_CORES 7u
enum { MT_F_SEM_DONE = 1, MT_F_SEM_GO, MT_F_CRE_TSK = 4, MT_F_STA_TSK = 6, MT_F_DEL_TSK = 8, MT_F_SIG = 10, MT_F_WAI = 12,
       MT_F_QUIT_SIG = 13, MT_F_QUIT_WAI = 15, MT_F_DEL_SEM = 16 };

struct t_ctsk { void *exinf; u32 tskatr; void (*task)(s32, void *); s32 itskpri, stksz, sstksz; void *stkptr, *uatb;
                s32 lsid, resid, domid; u32 assprc; u8 oname[8]; };        /* 0x38 bytes (CreateTask 0x5390ACF0) */
struct t_csem { void *exinf; u32 sematr; s32 isemcnt, maxsem; u32 rsv[3]; }; /* 0x1C bytes (Semaphore::Create 0x5390976C) */

struct crew;
struct worker { struct crew *w; s32 slot, tid, go; u32 found, busy_us; u32 core0, core1, stack, wake_sum, wake_max, idle; };
struct crew {
    const struct ctx *c;
    struct state *s;
    struct mf_par par;
    mf_job job;
    void *arg;
    s32 count, done;
    u32 next, fin, gone;                 /* atomic: next job index; rounds finished by workers; workers past their last access */
    volatile u32 quit;
    u32 n, broken;                       /* workers started; a kernel call failed during the merge (rest inline) */
    u32 jobs[1 + MT_WORKERS];
    struct worker k[MT_WORKERS];
    /* probes (log version 8) */
    u32 jobs_p[2][1 + MT_WORKERS], job_busy[1 + MT_WORKERS], job_max[1 + MT_WORKERS];
    u32 busy_p[2][1 + MT_WORKERS], job_min2[1 + MT_WORKERS], m_wait_p[2], rounds_p[2];   /* log version 11 */
    volatile u32 t_go;                   /* this task's clock reading when it signalled the workers' go */
    /* stages (log version 13): the core's marks (crew_mark), the round's first "no job left" (crew_take) */
    u32 st_cur, st_t0, st_us[MF_STAGES], st_tail[MF_STAGES], st_rounds[MF_STAGES];
    u32 ex_t;                            /* atomic: clock reading | 1 when a thread first found no job left in this round, 0 none */
    u32 m_wait, rounds, probe;           /* probe: a bandwidth round, its jobs are not counted */
};

static void crew_fail(struct crew *w, u32 step, s32 code)
{
    if (!w->s->log.mt_fail_step) { w->s->log.mt_fail_step = step; w->s->log.mt_fail_code = (u32)code; }
}

static void crew_take(struct crew *w, s32 slot)
{
    const struct ctx *c = w->c;
    u32 t = w->probe ? 0 : now_p(c, w->s);
    for (;;) {
        s32 i = (s32)__atomic_fetch_add(&w->next, 1u, __ATOMIC_RELAXED);
        if (i >= w->count) {
            if (!w->probe && !__atomic_load_n(&w->ex_t, __ATOMIC_RELAXED)) {     /* the round's tail begins (version 13) */
                u32 z = 0;
                __atomic_compare_exchange_n(&w->ex_t, &z, now_p(c, w->s) | 1u, 0, __ATOMIC_RELAXED, __ATOMIC_RELAXED);
            }
            return;
        }
        w->job(w->arg, i, slot);
        if (slot) {
            c->rot_rdq(MT_PRI);                             /* a worker: another ready task of its priority runs first */
            prefetch_on();                                  /* mf15: it may go on on another core (mf13 logs: workers moved
                                                               from core 0 to cores 1 and 2), whose prefetcher may be off */
        }
        if (w->probe) continue;
        try_wake(c, w->s);                                  /* the indicator: whoever finishes a job may wake the UI */
        w->jobs[slot]++;
        {   /* probes: per phase, time inside jobs, longest job; shortest phase-2 job (version 11) */
            u32 t1 = now_p(c, w->s), d = pus(c, w->s, t, t1), ph = w->s->mt_phase2 ? 1 : 0;
            w->jobs_p[ph][slot]++;
            w->job_busy[slot] += d;
            w->busy_p[ph][slot] += d;
            if (ph && (w->job_min2[slot] == 0 || d + 1 < w->job_min2[slot])) w->job_min2[slot] = d + 1;
            if (d > w->job_max[slot]) w->job_max[slot] = d;
            t = t1;
        }
    }
}

/* the worker's stack below its entry stack pointer: painted at its start, the deepest use read at its end */
static u32 stack_sp(void) { u32 v; __asm__ volatile("mov %0, sp" : "=r"(v)); return v; }
static void stack_paint(u32 sp)
{
    volatile u32 *p = (volatile u32 *)((sp - PAINT_BYTES) & ~3u), *e = (volatile u32 *)((sp - 64) & ~3u);
    while (p < e) *p++ = PAINT;
}
static u32 stack_used(u32 sp)
{
    const volatile u32 *p = (const volatile u32 *)((sp - PAINT_BYTES) & ~3u), *e = (const volatile u32 *)((sp - 64) & ~3u);
    while (p < e && *p == PAINT) p++;
    return sp - (u32)p;
}

static void crew_worker(s32 stacd, void *exinf)
{
    struct worker *k = (struct worker *)stacd;   /* stacd and exinf: the same pointer */
    struct crew *w = k->w;
    const struct ctx *c = w->c;
    s32 done = w->done, go = k->go, r;
    u32 found = actlr_get(), sp = stack_sp();
    (void)exinf;
    k->found = found;
    k->core0 = core() + 1;
    if (PROBES) stack_paint(sp);
    for (;;) {
        u32 t0, t1, tw = w->probe ? 0 : now_p(c, w->s);
        r = c->wai_sem(go, 1, -1);
        if (r < 0 || w->quit) break;
        if (!w->probe && tw) k->idle += pus(c, w->s, tw, now_p(c, w->s));     /* waiting for the go (version 11) */
        if (!w->probe) {                                    /* probe: go signal -> running */
            u32 d = pus(c, w->s, w->t_go, now_p(c, w->s));
            k->wake_sum += d;
            if (d > k->wake_max) k->wake_max = d;
        }
        prefetch_on();
        t0 = c->tick(w->s->timer);
        crew_take(w, k->slot);
        t1 = c->tick(w->s->timer);
        if (t1 != t0) k->busy_us += us(c, w->s, t0, t1);
        __atomic_fetch_add(&w->fin, 1u, __ATOMIC_SEQ_CST);
        c->sig_sem(done, 1);
    }
    prefetch_back(found);
    k->stack = PROBES ? stack_used(sp) : 0;
    k->core1 = core() + 1;
    __atomic_fetch_add(&w->gone, 1u, __ATOMIC_SEQ_CST);     /* from here on: c (firmware data), done, the stack only */
    if (r >= 0) c->sig_sem(done, 1);
    c->exd_tsk();
    for (;;) ;
}

static void crew_run(void *p, mf_job job, void *arg, s32 count)
{
    struct crew *w = (struct crew *)p;
    const struct ctx *c = w->c;
    u32 i, sent = 0, fin0 = __atomic_load_n(&w->fin, __ATOMIC_SEQ_CST);
    s32 r;
    w->job = job; w->arg = arg; w->count = count;
    __atomic_store_n(&w->next, w->broken ? (u32)count : 0u, __ATOMIC_SEQ_CST);
    if (w->broken) {                                        /* inline */
        for (r = 0; r < count; r++) { job(arg, r, 0); w->jobs[0]++; }
        return;
    }
    if (!w->probe) {
        struct state *s = w->s;
        if (!s->log.t_ref_us && __atomic_load_n(&w->par.ref_done, __ATOMIC_RELAXED)) s->log.t_ref_us = pus(c, s, s->merge_tick, now_p(c, s));
        w->rounds++;
        w->rounds_p[s->mt_phase2 ? 1 : 0]++;
        if (!s->mt_phase2) { s->p1_rounds++; if (s->q_active) progress_rounds((struct stopper *)s->q_active); }
    }
    w->t_go = now_p(c, w->s);
    __atomic_store_n(&w->ex_t, 0u, __ATOMIC_RELAXED);
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
    for (i = 0; i < w->n; i++) {
        r = c->sig_sem(w->k[i].go, 1);
        if (r < 0) { crew_fail(w, MT_F_SIG + i, r); w->broken = 1; } else sent++;
    }
    crew_take(w, 0);
    {
        u32 t0 = now_p(c, w->s);
        for (i = 0; i < sent && !w->broken; i++) {
            r = c->wai_sem(w->done, 1, -1);
            if (r < 0) { crew_fail(w, MT_F_WAI, r); w->broken = 1; }
        }
        if (!w->probe) { u32 d = pus(c, w->s, t0, now_p(c, w->s)); w->m_wait += d; w->m_wait_p[w->s->mt_phase2 ? 1 : 0] += d; }
    }
    if (w->broken) while (__atomic_load_n(&w->fin, __ATOMIC_SEQ_CST) - fin0 < sent) ;     /* the signalled workers finish */
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
    if (!w->probe && w->st_cur < MF_STAGES) {               /* version 13: the round's tail and count, by stage */
        u32 e = __atomic_load_n(&w->ex_t, __ATOMIC_RELAXED);
        if (e) w->st_tail[w->st_cur] += pus(c, w->s, e, now_p(c, w->s));
        w->st_rounds[w->st_cur]++;
    }
}

/* the core's stage marks (struct mf_par.mark; this task, between jobs): the time since the previous mark goes to that stage
 * (log version 13); stage MF_STAGES closes the last one */
static void crew_mark(void *p, s32 stage)
{
    struct crew *w = (struct crew *)p;
    u32 now = now_p(w->c, w->s);
    if (w->st_cur < MF_STAGES) w->st_us[w->st_cur] += pus(w->c, w->s, w->st_t0, now);
    w->st_cur = stage >= 0 && stage < MF_STAGES ? (u32)stage : MF_STAGES;
    w->st_t0 = now;
}

static void crew_stop(struct crew *w)
{
    const struct ctx *c = w->c;
    u32 i, sent = 0;
    s32 r;
    w->quit = 1;
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
    for (i = 0; i < w->n; i++) {
        r = c->sig_sem(w->k[i].go, 1);
        if (r < 0) crew_fail(w, MT_F_QUIT_SIG + i, r); else sent++;
    }
    for (i = 0; i < sent && !w->broken; i++) {
        r = c->wai_sem(w->done, 1, -1);
        if (r < 0) { crew_fail(w, MT_F_QUIT_WAI, r); w->broken = 1; }
    }
    for (i = 0; i < MT_WORKERS; i++)
        if (w->k[i].go) { r = c->del_sem(w->k[i].go); if (r < 0) crew_fail(w, MT_F_DEL_SEM + 1 + i, r); w->k[i].go = 0; }
    while (__atomic_load_n(&w->gone, __ATOMIC_SEQ_CST) < w->n) ;
    if (w->done) { r = c->del_sem(w->done); if (r < 0) crew_fail(w, MT_F_DEL_SEM, r); w->done = 0; }
    w->n = 0;
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
}

/* the workers; returns the number of threads (1: none started, everything undone) */
static u32 crew_start(const struct ctx *c, struct state *s, struct crew *w)
{
    struct t_csem cs;
    struct t_ctsk ct;
    u32 i;
    s32 r;
    zero(w, sizeof *w);
    w->c = c; w->s = s; w->par.n = 1; w->par.run = crew_run; w->par.par_ctx = w;
    zero(&cs, sizeof cs); cs.maxsem = 65535;
    r = c->cre_sem(&cs);
    if (r <= 0) { crew_fail(w, MT_F_SEM_DONE, r); return 1; }
    w->done = r;
    for (i = 0; i < MT_WORKERS; i++) {
        r = c->cre_sem(&cs);
        if (r <= 0) { crew_fail(w, MT_F_SEM_GO, r); crew_stop(w); return 1; }
        w->k[i].go = r;
    }
    for (i = 0; i < MT_WORKERS; i++) {
        struct worker *k = &w->k[i];
        k->w = w; k->slot = (s32)i + 1;
        zero(&ct, sizeof ct);
        ct.exinf = k; ct.tskatr = MT_ATR; ct.task = crew_worker; ct.itskpri = MT_PRI; ct.sstksz = MT_STACK; ct.assprc = MT_CORES;
        r = c->cre_tsk(&ct);
        if (r <= 0) { crew_fail(w, MT_F_CRE_TSK + i, r); crew_stop(w); return 1; }
        k->tid = r;
        r = c->sta_tsk(k->tid, (s32)k);
        if (r < 0) {
            crew_fail(w, MT_F_STA_TSK + i, r);
            r = c->del_tsk(k->tid);
            if (r < 0) crew_fail(w, MT_F_DEL_TSK + i, r);
            crew_stop(w);
            return 1;
        }
        w->n = i + 1;
    }
    w->par.n = (s32)(1 + MT_WORKERS);
    return 1 + MT_WORKERS;
}

/* ---- once per power-on: does the memory feed three cores? (log version 8) ---------------------------------------------
 * The same BW_BYTES copy (the stock memcpy, prefetcher on) by this task alone, by this task and one worker at the same time,
 * by all three; each thread copies its own range of two buffers the group no longer needs (the alternates' copies). A job
 * waits (at most about 20 ms, or a spin limit) until every thread of the configuration has taken its job, so the copies
 * overlap; a thread that took no job leaves 0. */
struct bw_arg { struct crew *w; const u8 *src; u8 *const *dst; u32 want, cfg; volatile u32 arrived; u32 done[1 + MT_WORKERS]; };

static void bw_job(void *p, s32 i, s32 slot)
{
    struct bw_arg *A = (struct bw_arg *)p;
    const struct ctx *c = A->w->c;
    struct state *s = A->w->s;
    u32 t0, spins = 0;
    (void)i;
    if (slot < 0 || slot > (s32)MT_WORKERS || A->done[slot]) return;
    A->done[slot] = 1;
    __atomic_fetch_add(&A->arrived, 1u, __ATOMIC_SEQ_CST);
    t0 = now_p(c, s);
    while (__atomic_load_n(&A->arrived, __ATOMIC_SEQ_CST) < A->want && ++spins < (1u << 22) && pus(c, s, t0, now_p(c, s)) < 20000u) ;
    t0 = now_p(c, s);
    c->copy(A->dst[slot], A->src + (u32)slot * BW_BYTES, BW_BYTES);     /* (mf14: each slot into its own part) */
    s->log.bw_us[A->cfg][slot] = pus(c, s, t0, now_p(c, s)) + 1;
}

static void bw_probe(const struct ctx *c, struct state *s, struct crew *w, u32 threads, const u8 *src, u8 *const *dst)
{
    struct bw_arg A;
    u32 cfg, t0;
    s->bw_done = 1;
    s->log.bw_bytes = BW_BYTES;
    t0 = now_p(c, s);
    c->copy(dst[0], src, BW_BYTES);
    s->log.bw_us[0][0] = pus(c, s, t0, now_p(c, s)) + 1;
    w->probe = 1;
    for (cfg = 1; cfg < threads && !w->broken; cfg++) {
        zero(&A, sizeof A);
        A.w = w; A.src = src; A.dst = dst; A.want = cfg + 1; A.cfg = cfg;
        crew_run(w, bw_job, &A, (s32)(cfg + 1));
    }
    w->probe = 0;
}

/* mf_merge_mt with the workers (falls back to this task alone); fills the version 7 log words.  The crew stays up (merge_end
 * stops it): the once-per-power-on bandwidth probe runs after the write-back, with the scratch as its destination. */
static s32 merge_mt(const struct ctx *c, struct state *s, struct crew *w, const u16 *bayer, u16 *const *alt, s32 n, s32 black, s32 gd,
                    s32 white, u16 *out, const struct mf_mem *mem, u32 *threads, struct stopper *q)
{
    struct mf_log *g = &s->log;
    s32 r;
    u32 i, t0 = c->tick(s->timer);
    g->mt_pri = MT_PRI; g->mt_stack = MT_STACK;
    if (*threads > 1) *threads = crew_start(c, s, w);
    else { zero(w, sizeof *w); w->par.n = 1; w->c = c; w->s = s; }
    w->par.par_ctx = w; w->par.mark = crew_mark; w->st_cur = MF_STAGES;      /* stage marks (version 13), any thread count */
    g->mt_threads = *threads;
    g->mt_setup_us = us(c, s, t0, c->tick(s->timer));
    q->par = &w->par;
    r = mf_merge_parts(bayer, alt, n, (s32)s->width, (s32)s->height, (s32)s->width, black, s->ntab, (s32)g->nshift, c->rcp, gd, white,
                       (s32)g->vmax, s->ntab_w, (s32)g->nshift_w, out, (s32)s->width, mem, stop_check, q, &w->par, &g->st);
    q->par = 0;
    crew_mark(w, MF_STAGES);
    for (i = 0; i < MF_STAGES; i++) { g->st_us[i] = w->st_us[i]; g->st_tail_us[i] = w->st_tail[i]; g->st_rounds[i] = w->st_rounds[i]; }
    g->spec = MF_SPEC;
    g->mt_phase2_us = us(c, s, s->merge_tick, c->tick(s->timer));
    if (n > 0 && g->align_us[n - 1]) g->mt_phase1_us = g->align_us[n - 1];
    for (i = 0; i <= MT_WORKERS; i++) {
        g->mt_jobs[i] = w->jobs[i];
        g->jobs_p1[i] = w->jobs_p[0][i]; g->jobs_p2[i] = w->jobs_p[1][i]; g->job_busy_us[i] = w->job_busy[i]; g->job_max_us[i] = w->job_max[i];
        g->busy_p_us[0][i] = w->busy_p[0][i]; g->busy_p_us[1][i] = w->busy_p[1][i];
        g->job_min_p2_us[i] = w->job_min2[i] ? w->job_min2[i] - 1 : 0;
    }
    g->m_wait_us = w->m_wait; g->rounds = w->rounds;
    g->m_wait_p_us[0] = w->m_wait_p[0]; g->m_wait_p_us[1] = w->m_wait_p[1]; g->rounds_p[0] = w->rounds_p[0]; g->rounds_p[1] = w->rounds_p[1];
    return r;
}

/* after the merge (every outcome): the bandwidth probe once per power-on (src: a held alternate, read only; dst: one part per
 * thread, no longer needed), then the workers stop */
static void merge_end(const struct ctx *c, struct state *s, struct crew *w, u32 threads, s32 r, const u8 *src, const struct mf_mem *mem)
{
    struct mf_log *g = &s->log;
    u32 i, fit = 1;
    u8 *dst[MF_PARTS];
    for (i = 0; i < MF_PARTS; i++) { dst[i] = (u8 *)mem->part[i]; fit &= mem->bytes[i] >= BW_BYTES; }
    if (PROBES && r == MF_OK && g->written && !s->bw_done && src && s->copy_bytes >= (1 + MT_WORKERS) * BW_BYTES && fit && 1 + MT_WORKERS <= MF_PARTS)
        bw_probe(c, s, w, threads, src, dst);
    if (threads > 1) {
        crew_stop(w);
        for (i = 0; i < MT_WORKERS; i++) {
            g->mt_busy_us[i] = w->k[i].busy_us; g->mt_actlr[i] = w->k[i].found;
            g->w_core[i][0] = w->k[i].core0; g->w_core[i][1] = w->k[i].core1; g->w_stack[i] = w->k[i].stack;
            g->w_wake_sum_us[i] = w->k[i].wake_sum; g->w_wake_max_us[i] = w->k[i].wake_max; g->w_idle_us[i] = w->k[i].idle;
        }
    }
}

/* the merge memory (mf14): the scratch for `threads` threads in MF_PARTS blocks of IMAGE2 (mf_merge_parts: part 0 and part 1 one
 * pyramid level 0 each, 26.5 MB at 6304 x 4210, part 2 the rest), the output over parts 0 and 1 (full-res rows 0 .. split-1 over
 * part 0, the rest over part 1, each part at least its band; part 1 also the 31 bytes the write-back copy rounds up).  The blocks
 * are asked one by one, largest first, all or nothing: if one is refused the ones obtained are freed and 0 is returned.  Every
 * block, its size and IMAGE2's free total / largest before the first and after each block are logged (try 0: 3 threads, try 1:
 * 1 thread). */
static u32 merge_parts(const struct ctx *c, struct state *s, struct mf_log *g, u32 n, u32 threads, struct mf_mem *m, u16 **out)
{
    u32 want[MF_PARTS], sz[MF_PARTS], ord[MF_PARTS], k, i, j, rows = 2 * s->width, split = (s->height / 2) & ~1u, tr = g->parts_tries++;
    void *a = c->img();
    if (tr > 1 || !a || mf_parts_size_mt((s32)s->width, (s32)s->height, (s32)n, (s32)threads, want) < 0) return 0;
    sz[0] = want[0] > split * rows ? want[0] : split * rows;
    sz[1] = want[1] > (s->height - split) * rows + 32 ? want[1] : (s->height - split) * rows + 32;
    sz[2] = want[2];
    for (k = 0; k < MF_PARTS; k++) { sz[k] = ((sz[k] + 63) & ~63u) + 64; ord[k] = k; g->part_size[tr][k] = sz[k]; }
    for (i = 0; i < MF_PARTS; i++)           /* largest first */
        for (j = i + 1; j < MF_PARTS; j++)
            if (sz[ord[j]] > sz[ord[i]]) { k = ord[i]; ord[i] = ord[j]; ord[j] = k; }
    g->parts_threads = threads; g->out_split = split; g->merge_layout = 3; g->out_room = 0;
    g->need = sz[0] + sz[1] + sz[2];
    pool(c, 1, &g->part_pool[tr][0][0], &g->part_pool[tr][0][1]);
    for (i = 0; i < MF_PARTS; i++) {
        k = ord[i];
        s->blk[k] = take(c, sz[k], 1, 0, 0);
        g->part_addr[tr][k] = (u32)s->blk[k];
        pool(c, 1, &g->part_pool[tr][i + 1][0], &g->part_pool[tr][i + 1][1]);
        if (!s->blk[k]) {                    /* all or nothing */
            for (j = 0; j < MF_PARTS; j++) { if (s->blk[j]) c->img_free(a, s->blk[j]); s->blk[j] = 0; }
            return 0;
        }
    }
    for (k = 0; k < MF_PARTS; k++) { m->part[k] = (void *)(((u32)s->blk[k] + 63) & ~63u); m->bytes[k] = sz[k] - 64; }
    *out = (u16 *)m->part[0];
    m->out2 = (u16 *)m->part[1]; m->out_split = (s32)split;
    g->block = (u32)s->blk[0];
    return 1;
}

static s32 round_black(const u8 *si)

{
    u32 sum = rd32(si, SI_BLACK) + rd32(si, SI_BLACK + 4) + rd32(si, SI_BLACK + 8) + rd32(si, SI_BLACK + 12);
    u32 q = sum >> 2, r = sum & 3;      /* round half to even, as Python's round() of the mean */
    if (r > 2 || (r == 2 && (q & 1))) q++;
    return (s32)q;
}

/* ---- the back end: module 9 of a still recipe --------------------------------------------------------------------- */

/* ---- mf17: the merged frame's development (docs T7n) ------------------------------------------------------------------
 * Night brightening (TONE_HOOK, c/night_tone.c, bit-exact with night_tone_ref.py): after the
 * write-back into the frame's own Bayer buffer, before its cache clean and RAW_CODEC, on the JPEG's window of the raster
 * (6304 x 4210 frames only: rows 58.., columns 54.., 4128 x 6192 = the DNG active area (34, 26) + the JPEG crop (24, 28), RGGB),
 * in the steps of night_tone.h: init (this task; the only step that can refuse, nothing written yet), pass 1 in TONE_BANDS bands
 * of 16-row multiples on the merge's threads, plan (this task), the stop check (power key, time limit: the frame is still
 * untouched), pass 2 in the same bands, finish.  Scratch: part 2 of the merge memory (the output was copied out of parts 0 / 1;
 * the bandwidth probe follows).  Inputs from the camera: black / white the merge's levels; the white balance = frame 1's final
 * gains (SI+0x2EBE8..EE at its Pipe1) as Q12 of their G (4096 each if not seen); the nominal ISO; the luminance scale of the
 * demonstration 2^(BaselineExposure - 0.406) (highlight correction applied) or 2^(BaselineExposure + 0.594 - 0.15) (not), with
 * BaselineExposure = log2(1448 white / (h 16383)), h = 1024 / 2048 (the camera's own formula 0x53938EF8, docs T7n.9), computed
 * here because the camera computes it at Pipe1, after module 9; vignetting k1 0.3705, k2 0.4737 (the demonstration's fit of the
 * camera's JPEG).  Any error: the frame unchanged, no lift. */
#define TONE_Y0 58
#define TONE_X0 54
#define TONE_H 4128
#define TONE_W 6192
#define TONE_BANDS 24u
#define TONE_K1 24283                    /* round(0.3705326 x 2^16) */
#define TONE_K2 31046                    /* round(0.4737223 x 2^16) */
#define TONE_HC_Q16 49450u               /* round(2^-0.406 x 2^16) */
#define TONE_NOHC_Q16 89146u             /* round(2^(0.594 - 0.15) x 2^16) */
struct tone_job { struct night_tone_ctx *ctx; s32 band, h, pass; volatile s32 err; const struct ctx *c; struct state *s; u32 done, lo, hi; };
static void show_pct(struct state *s, const struct ctx *c, u32 t);
static void tone_job_fn(void *p, s32 i, s32 slot)
{
    struct tone_job *t = (struct tone_job *)p;
    s32 y0 = i * t->band, y1 = y0 + t->band, r;
    u32 n;
    if (y0 < t->h) {
        if (y1 > t->h) y1 = t->h;
        r = t->pass == 1 ? night_tone_stats_rows(t->ctx, y0, y1) : night_tone_apply_rows(t->ctx, y0, y1);
        if (r) t->err = r;
    }
    n = __atomic_add_fetch(&t->done, 1u, __ATOMIC_SEQ_CST);
    if (PROGRESS_BAR && slot == 0 && t->s) show_pct(t->s, t->c, t->lo + (t->hi - t->lo) * (n < TONE_BANDS ? n : TONE_BANDS) / TONE_BANDS);   /* (this task only) */
}

static s32 tone_stop(void *p) { return stop_check(p, -1); }
static void tone_run(const struct ctx *c, struct state *s, struct mf_log *g, u16 *bayer, s32 black, s32 white, s32 step,
                     const struct mf_mem *mem, struct stopper *q, struct crew *w)
{
    struct night_tone_lum lum;
    struct night_tone_info info;
    struct night_tone_ctx *nc = 0;
    struct tone_job tj;
    u16 wb[4];
    u32 i, t0, gm, need, rq;
    s32 r, iso;
    g->tone_menu = TONE_MENU | (u32)rd8(c->user, NB_TONE) << 8;
    g->tone_on = TONE_MENU ? !(rd8(c->user, NB_TONE) & 1) : 1;  /* final build: no menu line, the old byte is not read for this */
    if (!g->tone_on) return;
    t0 = now_p(c, s);
    g->tone_ret = 0xeee0;                                          /* (not run: geometry, see below) */
    if (s->width != 6304 || s->height != 4210 || g->cfa != 0) return;
    gm = s->wb1_ok ? ((u32)s->wb1[1] + s->wb1[2] + 1) / 2 : 0;    /* frame 1's gains (R, G1, G2, B) as Q12 of their G */
    for (i = 0; i < 4; i++) {
        u32 v = gm ? (u32)s->wb1[i] * 4096u / gm : 4096u;
        wb[i] = (u16)(v < 256 ? 256 : v > 65535 ? 65535 : v);
        g->tone_wb[i] = wb[i];
    }
    iso = step >= NS_FIRST && step <= NS_LAST ? (s32)c->iso_tab[step] : 0;
    rq = (1448u * (u32)white * (g->hc_applied ? 64u : 32u) + 8191u) / 16383u;   /* 2^BaselineExposure in Q16: 1448 white 2^16 / (h 16383) */
    lum.scale_q16 = (s32)(((u64)rq * (g->hc_applied ? TONE_HC_Q16 : TONE_NOHC_Q16) + 32768) >> 16);
    lum.vig_k1_q16 = TONE_K1; lum.vig_k2_q16 = TONE_K2;
    g->tone_scale_q16 = (u32)lum.scale_q16; g->tone_iso = (u32)iso;
    zero(&info, sizeof info);
    need = night_tone_scratch_bytes(TONE_W, TONE_H);
    bayer += TONE_Y0 * s->width + TONE_X0;
    r = need && need <= mem->bytes[2] ? night_tone_init(bayer, TONE_W, TONE_H, (s32)s->width, black, white, wb, iso, &lum, mem->part[2],
                                                        mem->bytes[2], &nc) : NT_ERR_SCRATCH;
    if (r == 0) {                                                  /* mf18: N (so g + d) at most TONE_MAX_Q8 */
        g->tone_nmax_q16 = 0x7fffffffu;
        if (TONE_MAX_Q8 > 0) { r = night_tone_set_n_max(nc, TONE_MAX_Q8 << 8); if (r == 0) g->tone_nmax_q16 = TONE_MAX_Q8 << 8; }
    }
    if (r == 0) {                                                  /* final build: d at most TONE_DMAX_Q8 */
        g->tone_dmax_q16 = 0x7fffffffu;
        if (TONE_DMAX_Q8 > 0) { r = night_tone_set_d_max(nc, TONE_DMAX_Q8 << 8); if (r == 0) g->tone_dmax_q16 = TONE_DMAX_Q8 << 8; }
    }
    g->tone_t[0] = pus(c, s, t0, now_p(c, s));
    if (r == 0 && tone_stop(q)) r = 0x7001;
    if (r == 0) {
        tj.ctx = nc; tj.h = TONE_H; tj.band = ((TONE_H + TONE_BANDS - 1) / TONE_BANDS + 15) & ~15; tj.pass = 1; tj.err = 0;
        tj.c = c; tj.s = s; tj.done = 0; tj.lo = P_WRITTEN; tj.hi = P_TONE1;
        crew_run(w, tone_job_fn, &tj, (s32)TONE_BANDS);
        r = tj.err;
        g->tone_t[1] = pus(c, s, t0, now_p(c, s));
    }
    if (r == 0) r = night_tone_plan(nc, &info);
    g->tone_t[2] = pus(c, s, t0, now_p(c, s));
    if (r == 0 && info.changed && tone_stop(q)) r = 0x7002;        /* power key / time limit between the two passes: untouched */
    if (r == 0 && info.changed) {
        tj.pass = 2; tj.err = 0; tj.done = 0; tj.lo = P_TONE1; tj.hi = 99;
        crew_run(w, tone_job_fn, &tj, (s32)TONE_BANDS);
        r = tj.err;
        if (r == 0) r = night_tone_finish(nc, &info);
    }
    g->tone_us = pus(c, s, t0, now_p(c, s));
    g->tone_ret = (u32)r + 1;
    g->tone_g_q8 = info.g_q8; g->tone_d_q8 = info.d_q8; g->tone_n_q8 = info.n_q8; g->tone_lift_q8 = info.dark_lift_q8;
    g->tone_full_q8 = info.g_full_q8; g->tone_cap_q8 = info.g_cap_q8;
    g->tone_q16[0] = (u32)info.g_q16; g->tone_q16[1] = (u32)info.d_q16; g->tone_q16[2] = (u32)info.n_q16;
    g->tone_q16[3] = (u32)info.g_full_q16; g->tone_q16[4] = (u32)info.g_cap_q16;
    g->tone_clip[0] = info.clip_before; g->tone_clip[1] = info.clip_after; g->tone_clip[2] = (u32)info.clip_delta_ppm;
    g->tone_changed = (u32)info.changed;
    g->boost8 = r == 0 && info.changed && info.dark_lift_q8 > 0 ? (info.dark_lift_q8 + 16) >> 5 : 0;
}

/* final build (WB_FIRST_V2): frame 1's white balance result (the SI words WB_CALC wrote, see WB_FIRST_V2) kept and put back */
static void v2_take(struct state *s, const u8 *si)
{
    u32 i;
    for (i = 0; i < V2_A_N / 2; i++) s->v2[i] = rd16(si, V2_A + 2 * i);
    for (i = 0; i < V2_B_N / 2; i++) s->v2[V2_A_N / 2 + i] = rd16(si, V2_B + 2 * i);
    for (i = 0; i < V2_C_N / 2; i++) s->v2[(V2_A_N + V2_B_N) / 2 + i] = rd16(si, V2_C + 2 * i);
    s->v2hr[0] = rd32(si, V2_HR0); s->v2hr[1] = rd32(si, V2_HR1); s->v2hr[2] = rd32(si, V2_HR2);
    s->v2_ok = 1;
}
static u32 v2_put(const struct state *s, u8 *si)               /* returns the words changed (mf22): bit 0 gains / stashes (+0x2EBE8..),
                                                                   bit 1 light source (+0x34968..), bit 2 AsShotNeutral (+0x38BA4..),
                                                                   bit 3 headroom words; bit 4 AsShotNeutral left (frame 1's not set);
                                                                   0 (or 16): every word was equal already */
{
    u32 i, m = 0, c0 = (V2_A_N + V2_B_N) / 2;
    /* the AsShotNeutral rationals only if frame 1's denominators (words 1, 3, 7) are set (as ASN_FIRST) */
    u32 asn = (s->v2[c0 + 2] | s->v2[c0 + 3]) && (s->v2[c0 + 6] | s->v2[c0 + 7]) && (s->v2[c0 + 14] | s->v2[c0 + 15]);
    if (!asn) m |= 16;
    for (i = 0; i < V2_HW; i++) {
        u32 o;
        if (i >= c0 && !asn) break;
        o = i < V2_A_N / 2 ? V2_A + 2 * i : i < (V2_A_N + V2_B_N) / 2 ? V2_B + 2 * (i - V2_A_N / 2) : V2_C + 2 * (i - (V2_A_N + V2_B_N) / 2);
        if (rd16(si, o) != s->v2[i]) { m |= i < V2_A_N / 2 ? 1u : i < c0 ? 2u : 4u; *(volatile u16 *)(si + o) = s->v2[i]; }
    }
    if (rd32(si, V2_HR0) != s->v2hr[0]) { m |= 8; *(volatile u32 *)(si + V2_HR0) = s->v2hr[0]; }
    if (rd32(si, V2_HR1) != s->v2hr[1]) { m |= 8; *(volatile u32 *)(si + V2_HR1) = s->v2hr[1]; }
    if (rd32(si, V2_HR2) != s->v2hr[2]) { m |= 8; *(volatile u32 *)(si + V2_HR2) = s->v2hr[2]; }
    return m;
}
/* 20 log words: gains (2), headroom gains (2), +0x38AE8, +0x38AEC, +0x38B08, Cte stash (2), Auto stash (2), +0x34968, AsShotNeutral (8) */
static void wb_set_of(const u8 *si, u32 *o)
{
    u32 i;
    o[0] = rd32(si, 0x2ebe8); o[1] = rd32(si, 0x2ebec); o[2] = rd32(si, 0x2ebf0); o[3] = rd32(si, 0x2ebf4);
    o[4] = rd32(si, V2_HR0); o[5] = rd32(si, V2_HR1); o[6] = rd32(si, V2_HR2);
    o[7] = rd32(si, 0x2ec58); o[8] = rd32(si, 0x2ec5c); o[9] = rd32(si, 0x2ec60); o[10] = rd32(si, 0x2ec64);
    o[11] = rd32(si, V2_B);
    for (i = 0; i < 8; i++) o[12 + i] = rd32(si, SI_ASN + 4 * i);
}
/* the learned AWB's 64-byte diagnostic record (read only; zeros if its state is not there) */
static void awb2_diag(u32 *o)
{
    const u8 *st = (const u8 *)*(const volatile u32 *)AWB2_SLOT;
    u32 i;
    for (i = 0; i < 16; i++) o[i] = 0;
    if (!ram(st) || rd32(st, 0) != AWB2_DIAG_MAGIC) return;
    for (i = 0; i < 16; i++) o[i] = rd32(st, 4 * i);
}

/* The merged frame's ISO for the camera's own development (NR_AUTO): its noise is NR_EQ_EIGHTHS eighths below a single frame,
 * plus the brightening's lift.  idx_eq = round(8 Sv) - 8 - NR_EQ_EIGHTHS + boost8, Sv_eq = (idx_eq + 8) / 8 exactly (both the
 * truncating 0x53739840 and the rounding readers then find the same index).  Here (module 9) only the ELA on / off byte is made
 * again with 0x53739840 at Sv_eq and NR Auto (SI+0x7E7 = 0), and only if the recipe was prepared with ELA on (its ElaNoise buffer
 * demand +0x33E was set from that byte at preparation: an off -> on change would run ELA without its buffer); SI goes back to
 * the nominal values at once (RAW_CODEC, this module, sees them).  eq_module then sets Sv_eq / Auto for ELA (module 10), the
 * nominal Sv for WB_CALC (2), Sv_eq for Pipe1 (4: its tone / shadow compute, CNR 11 / 12, digital filter 13) and both nominal
 * values at JPEG_ENC (7), before the store (8) writes EXIF / MakerNote / DNG. */
static void eq_setup(const struct ctx *c, struct state *s, struct mf_log *g, u8 *recipe, u8 *si, u8 *params)
{
    u32 prep = g->nr_frame[GROUP - 1] ? g->nr_frame[GROUP - 1] - 1 : 0;
    s32 e8 = fxk(rd32(si, SI_SV), 8), q;
    if (e8 == 0x7fffffff || e8 < 9) return;
    q = e8 - NR_EQ_EIGHTHS + g->boost8;
    if (q < 9) q = 9;
    if (q > 18 * 8) q = 18 * 8;
    s->eq_sv_nom = rd32(si, SI_SV); s->eq_nr_nom = rd8(si, SI_NRSET); s->eq_sv = f_eighths(q);
    g->sv_nom = s->eq_sv_nom; g->sv_eq = s->eq_sv; g->idx_eq = q - 8; g->nrset_nom = s->eq_nr_nom; g->nr_prep = prep + 1;
    if (NR_AUTO && prep && !ram((const u8 *)rd32(params, 0x3c))) g->nr_new = 0xeee00;          /* (0x53739840 reads [[params+0x3C]+0x156]) */
    else if (NR_AUTO && prep) {
        *(volatile u8 *)(si + SI_NRSET) = 0;
        *(volatile u32 *)(si + SI_SV) = s->eq_sv;
        c->nr_calc(params, si, rd32(recipe, R_SEQTYPE));
        *(volatile u32 *)(si + SI_SV) = s->eq_sv_nom;
        *(volatile u8 *)(si + SI_NRSET) = (u8)s->eq_nr_nom;
        g->nr_new = ((u32)rd8(params, P_NR) + 1) | (u32)rd8(recipe, 0x33e) << 8;
        if (rd8(params, P_NR) && !rd8(recipe, 0x33e)) *(volatile u8 *)(params + P_NR) = 0;   /* (never without its buffer) */
    }
    s->eq_recipe = recipe; s->eq_index = rd32(si, SI_INDEX); s->eq_nr = NR_AUTO;
}

/* the merged frame's later modules, and frame 1's Pipe1 (its white balance gains); log words only while its log waits */
/* mf23 LOG_DEFER (back end, the merged frame's module 7, before its store): wait for the UI task's REVIEW_END check, at most
 * LOG_WAIT_US after the group's end (a release or the power key: at once), sleeping on a private semaphore 50 ms at a time */
static void log_wait(const struct ctx *c, struct state *s)
{
    struct t_csem cs;
    u32 t0 = c->tick(s->timer), why = 0, t;
    s32 id;
    if (!s->log_due) return;
    if (!LOG_DEFER) { s->log.log_wait_why = 6; return; }
    zero(&cs, sizeof cs); cs.maxsem = 1;
    id = c->cre_sem(&cs);
    if (id <= 0) { s->log.log_wait_why = 7; return; }
    for (;;) {
        u32 posted = __atomic_load_n(&s->dv_posted, __ATOMIC_SEQ_CST), rr = __atomic_load_n(&s->dv.re_ret, __ATOMIC_SEQ_CST);
        if (!__atomic_load_n(&s->dv_req, __ATOMIC_SEQ_CST)) {       /* (dv_req set: the UI has not started this group's window yet) */
            if (posted == 2) why = 1;
            else if (rr && (rr & 0xff) != 1) why = 2;
        }
        if (why) break;
        if (__atomic_load_n(&s->dv_rel, __ATOMIC_SEQ_CST) || ((rd32((const void *)CIM_GUARD, 0) & 1) && rd8((const void *)CIM_OBJ, 0x27))) why = 4;
        else if (s->shut || shutdown(s)) why = 5;
        else if (us(c, s, s->last_end_tick, c->tick(s->timer)) >= LOG_WAIT_US) why = 3;
        if (why) break;
        c->wai_sem(id, 1, 50);
    }
    c->del_sem(id);
    t = us(c, s, t0, c->tick(s->timer));
    s->log.log_wait_us = t + 1; s->log.log_wait_why = why;
}

static void eq_module(const struct ctx *c, struct state *s, u8 *recipe, u32 module)
{
    struct mf_log *g = &s->log;
    u8 *si = (u8 *)rd32(recipe, R_SI);
    u32 k, lg = s->log_due;
    (void)c;
    if (!ram(si)) return;
    if (module == MOD_PIPE1 && s->wb_recipe == recipe && rd32(si, SI_INDEX) == s->wb_index && !s->wb1_ok) {
        for (k = 0; k < 4; k++) s->wb1[k] = rd16(si, SI_WB + 2 * k);
        s->wb1_ok = 1; s->wb_recipe = 0;
        if (s->phase == 1) { g->wb1[0] = s->wb1[0] | (u32)s->wb1[1] << 16; g->wb1[1] = s->wb1[2] | (u32)s->wb1[3] << 16; }
        if (WB_FIRST_V2) {
            v2_take(s, si);
            if (s->phase == 1) { wb_set_of(si, g->wbs1); awb2_diag(g->awbd1); }
        }
    }
    if (!s->eq_recipe || recipe != s->eq_recipe) return;
    if (rd32(si, SI_INDEX) != s->eq_index) { s->eq_recipe = 0; s->eq_nr = 0; return; }   /* the recipe holds another frame now */
    k = module == MOD_ELA ? 0 : module == MOD_WB ? 1 : module == MOD_PIPE1 ? 2 : module == MOD_JPEG || module == MOD_STORE ? 3 : 4;
    if (k > 3) return;
    if (lg) g->eq_mod[k][0] = rd32(si, SI_SV);
    if (s->eq_nr) {
        if (k == 0 || k == 2) *(volatile u32 *)(si + SI_SV) = s->eq_sv;
        if (k == 0) *(volatile u8 *)(si + SI_NRSET) = 0;
        if (k == 1 || k == 3) *(volatile u32 *)(si + SI_SV) = s->eq_sv_nom;
        if (k == 3) *(volatile u8 *)(si + SI_NRSET) = (u8)s->eq_nr_nom;
    }
    if (lg) g->eq_mod[k][1] = rd32(si, SI_SV) | 0;
    if (k == 2) {
        u32 st = 4, b0 = rd32(si, SI_WB), b1 = rd32(si, SI_WB + 4);
        if (WB_FIRST_V2 && lg) { wb_set_of(si, g->wbs4[0]); awb2_diag(g->awbd4); }
        if (WB_FIRST_V2 && WB_FIRST && s->wb1_ok && s->v2_ok) {
            u32 m = v2_put(s, si);                                 /* (includes the four gains) */
            st = (b0 == rd32(si, SI_WB) && b1 == rd32(si, SI_WB + 4)) ? 3 : 1;
            if (lg) g->wbv2_state = ((m & 15) ? 1u : 4u) | m << 8;    /* (mf22: the sections written in bits 8..12) */
        } else if (WB_FIRST && s->wb1_ok) {
            for (st = 0; st < 4; st++) *(volatile u16 *)(si + SI_WB + 2 * st) = s->wb1[st];
            st = (b0 == rd32(si, SI_WB) && b1 == rd32(si, SI_WB + 4)) ? 3 : 1;
            if (lg) g->wbv2_state = WB_FIRST_V2 ? 2 : 5;
        } else if (WB_FIRST) { st = 2; if (lg) g->wbv2_state = WB_FIRST_V2 ? 2 : 5; }
        if (WB_FIRST_V2 && lg) wb_set_of(si, g->wbs4[1]);
        if (lg) { g->wb4[0][0] = b0; g->wb4[0][1] = b1; g->wb4[1][0] = rd32(si, SI_WB); g->wb4[1][1] = rd32(si, SI_WB + 4); g->wb_state = st; }
    }
    if (k == 3) { s->eq_recipe = 0; s->eq_nr = 0; log_wait(c, s); flush_log(c, s); }
}

/* the 4th frame: merge the held frames that can be used; returns the result code */
static u32 merge_run(const struct ctx *c, struct state *s, u8 *recipe, u8 *si, u16 *bayer, const s32 *qr, u32 usable)
{
    struct mf_log *g = &s->log;
    struct stopper q;
    struct crew w;
    u16 *alt[GROUP - 1], *out = 0;
    u8 *params = (u8 *)rd32(recipe, R_PARAMS);
    struct mf_mem mem;
    s32 black = round_black(si), bits = (s32)rd16(si, SI_BITS), white, step = qr[0] - 3, r, gd;
    u32 cfa = rd8(si, SI_CFA), n = 0, k, held = 0, t1, threads = 1 + MT_WORKERS, altk[GROUP - 1], why = 0;
    for (k = 0; k < GROUP - 1; k++) {
        struct frame_log *f = &g->f[k];
        u32 st;
        g->hold[k].st_merge = 0xff;
        if (!(f->flags & F_HELD)) continue;
        held++;
        st = hold_state(s, k);
        g->hold[k].st_merge = st;
        if (st != H_HELD && st != H_RELEASED) { f->flags |= F_DROPPED; why |= F_DROPPED; }
        else if (!still_ours(s, k)) { f->flags |= F_CANARY; why |= F_CANARY; g->hold[k].canary_before = 3; }
        else if (!(s->q[k][0] == qr[0] && s->q[k][1] == qr[1] && s->q[k][2] == qr[2]) || s->hcf[k] != rd8(si, SI_HC)) { f->flags |= F_EXPOSURE; why |= F_EXPOSURE; }
        else if (!canary_ok(c, s, k)) { f->flags |= F_CANARY; why |= F_CANARY; g->hold[k].canary_before = 2; }
        else {
            g->hold[k].canary_before = 1;
            altk[n] = k; alt[n++] = (u16 *)s->hpx[k]; f->flags |= F_USED;
            continue;
        }
        hold_resolve(c, s, k);                   /* not usable: given back before the merge block is asked */
    }
    g->n_alt = n;
    if (!usable) return R_GEOMETRY;
    if (!n) {
        if (why & F_EXPOSURE) return R_EXPOSURE;
        if (why & (F_CANARY | F_DROPPED)) return R_CANARY;
        for (k = 0; k < GROUP - 1; k++) if (g->f[k].flags & F_NO_MEMORY) return R_MEMORY;
        (void)held;
        return R_GEOMETRY;
    }
    g->black_used = (u32)black; g->iso_step = (u32)step;
    if (step < NS_FIRST || step > NS_LAST) return R_ISO;
    if (bits < 10 || bits > 16 || cfa > 3) return R_LEVELS;
    white = (1 << bits) - 1 - black - WHITE_BELOW;
    g->white_used = (u32)white;
    g->vmax = (u32)((1 << bits) - 1);        /* normalised alternates and the result stay within the raw data's bits (ref.py v8) */
    if (black <= 0 || white <= black + 256) return R_LEVELS;
    {                                        /* spec v9: highlight correction applied?  SI+0xBB7, else by black (>= 2048: not applied) */
        u32 hc = rd8(si, SI_HC);
        if (hc <= 1) { g->hc_src = 1; g->hc_applied = hc; }
        else { g->hc_src = 2; g->hc_applied = black < 2048; }
    }
    pool(c, 0, &g->pools_merge[0], &g->pools_merge[1]); pool(c, 1, &g->pools_merge[2], &g->pools_merge[3]);
    /* the burst is over (this is its 4th frame) and the back end does nothing else while we merge: IMAGE2 needs no margin.
     * IMAGE1 is never used: the stock pipeline's own buffers of the frames in flight live there */
    zero(&mem, sizeof mem);
    g->block_pool = 1;
    if (!merge_parts(c, s, g, n, threads, &mem, &out)) {
        threads = 1;                         /* no room for 3 threads' scratch */
        if (!merge_parts(c, s, g, n, 1, &mem, &out)) return R_MEMORY;
    }
    for (k = 0; k < n; k++) sync(c, alt[k], s->copy_bytes);      /* the hardware wrote them: clean + invalidate before reading */
    g->nshift = (u32)noise_table(c, step, black, white, s->ntab);
    g->ntab[0] = (u32)s->ntab[0]; g->ntab[1] = (u32)s->ntab[16]; g->ntab[2] = (u32)s->ntab[128]; g->ntab[3] = (u32)s->ntab[255];
    g->w_step = (u32)(step - (g->hc_applied ? HC_STEPS : 0) < NS_FIRST ? NS_FIRST : step - (g->hc_applied ? HC_STEPS : 0));
    g->nshift_w = (u32)weights_table(c, (s32)g->w_step, black, white, s->ntab_w, g);
    g->ntab_w[0] = (u32)s->ntab_w[0]; g->ntab_w[1] = (u32)s->ntab_w[16]; g->ntab_w[2] = (u32)s->ntab_w[128]; g->ntab_w[3] = (u32)s->ntab_w[255];
    gd = cfa == 1 || cfa == 2;
    s->merge_tick = c->tick(s->timer);
    s->app_ret = 0; s->shut = 0;
    /* mf14 / mf15 stopped the 4th frame's instant review from the UI task 0.5 s into the merge (CIM 0x533EAFDC); on the camera
     * (mf15) live view then never came back after the merge.  mf16: not done (REVIEW_STOP 0): the stock flow ends the review
     * after the merge, as in mf13, whose live view came back by itself (docs T7m) */
    if (REVIEW_STOP) __atomic_store_n(&s->app_req, s->merge_tick | 1u, __ATOMIC_SEQ_CST);
    q.c = c; q.s = s; q.par = 0; q.n = n; q.nstrips = (s->height / 2 + STRIP_ROWS - 1) / STRIP_ROWS;
    g->core_start = core() + 1;
    s->mt_phase2 = 0; s->shown_max = 0;
    s->progress = (u32)c->shown[0] + 1;     /* 0 % */
    show(c, s, s->merge_tick);               /* the spinner appears */
    s->actlr = actlr_get(); g->actlr_before = s->actlr;
    actlr_put(s->actlr | L1PCTL);
    s->p1_rounds = s->p1_r_last = s->p1_alts = 0; s->q_active = &q;
    r = merge_mt(c, s, &w, bayer, alt, (s32)n, black, gd, white, out, &mem, &threads, &q);
    s->q_active = 0;
    prefetch_back(s->actlr);                 /* every outcome: merged, stopped, error */
    t1 = c->tick(s->timer);
    g->merge_us = us(c, s, s->merge_tick, t1);
    if (s->shut) { merge_end(c, s, &w, threads, MF_ERR_STOP, 0, &mem); return R_SHUTDOWN; }   /* frame 4 untouched (mf17) */
    if (r == MF_ERR_STOP || g->merge_us > LIMIT_US || r != MF_OK) {
        merge_end(c, s, &w, threads, r, 0, &mem);
        if (r != MF_OK && r != MF_ERR_STOP) { g->stop_at = (u32)-r; return R_ERROR; }
        return R_TIME;
    }
    /* after the merge, before frame 4 is touched: every used alternate still held (not moved) and unchanged */
    {
        u32 bad = 0;
        for (k = 0; k < n; k++) {
            u32 owned = still_ours(s, altk[k]), ok = owned && canary_ok(c, s, altk[k]);
            g->hold[altk[k]].canary_after = ok ? 1 : owned ? 2 : 3;
            bad |= !ok;
        }
        if (bad) {                           /* all or nothing: frame 4 is untouched (the output lives in the parts) */
            merge_end(c, s, &w, threads, r, 0, &mem);
            return R_CANARY;
        }
    }
    {                                        /* the two output bands into frame 4 (part 1's band with the copy's rounding) */
        u32 b0 = (u32)mem.out_split * 2 * s->width;
        c->copy(bayer, out, b0);
        if (PROGRESS_BAR) show_pct(s, c, (P_MERGED + P_WRITTEN) / 2);
        c->copy((u8 *)bayer + b0, mem.out2, s->copy_bytes - b0);
        if (PROGRESS_BAR) show_pct(s, c, P_WRITTEN);
    }
    if (TONE_HOOK) tone_run(c, s, g, bayer, black, white, step, &mem, &q, &w);   /* mf17: night brightening, in place, before RAW_CODEC */
    sync(c, bayer, s->copy_bytes);
    sample(c, bayer, s->width, s->height, g->out_px, 0);
    g->written = 1;
    if ((u32)params >= 0x55000000u && (u32)params < 0xe0000000u) {
        g->nr_before = rd8(params, P_NR);
        if (NR_AUTO || WB_FIRST) eq_setup(c, s, g, recipe, si, params);
        if (ASN_FIRST) { s->asnm_recipe = recipe; s->asnm_index = rd32(si, SI_INDEX); }
        if (!NR_AUTO) *(volatile u8 *)(params + P_NR) = 0;
        g->nr_after = rd8(params, P_NR);
    }
    g->write_us = us(c, s, t1, c->tick(s->timer));
    g->t_written_us = pus(c, s, s->merge_tick, now_p(c, s));
    s->progress = 101;                       /* 100 %: the merged frame is written back (the wake-up that hides the indicator follows) */
    merge_end(c, s, &w, threads, r, (const u8 *)alt[0], &mem);
    return R_MERGED;
}

/* merge_run, and the waiting indicator hidden on every way out of it (only if it was shown) */
/* mf24 PROGRESS_BAR: the merged frame is written back (progress 101 = 100 %): the UI is woken and given up to PBAR_HOLD_MS to draw the
 * full bar (its draw counter, state +0x10, moves) before the screen goes; never while shutting down */
static void pbar_hold(const struct ctx *c, struct state *s)
{
    struct t_csem cs;
    u32 t0 = c->tick(s->timer), d0 = __atomic_load_n(&s->ui_draws, __ATOMIC_SEQ_CST);
    s32 id;
    if (s->shut || shutdown(s)) return;
    zero(&cs, sizeof cs); cs.maxsem = 1;
    id = c->cre_sem(&cs);
    if (id <= 0) return;
    show(c, s, t0);
    while (__atomic_load_n(&s->ui_draws, __ATOMIC_SEQ_CST) == d0 && !shutdown(s) && us(c, s, t0, c->tick(s->timer)) < PBAR_HOLD_MS * 1000u)
        c->wai_sem(id, 1, 10);
    c->del_sem(id);
    s->pbar_draws = __atomic_load_n(&s->ui_draws, __ATOMIC_SEQ_CST) - d0 + 1;
}

static u32 merge_group(const struct ctx *c, struct state *s, u8 *recipe, u8 *si, u16 *bayer, const s32 *qr, u32 usable)
{
    u32 r = merge_run(c, s, recipe, si, bayer, qr, usable);
    s->pbar_draws = 0;
    if (PROGRESS_BAR && r == R_MERGED && s->busy) pbar_hold(c, s);
    if (s->busy) { s->log.progress_end = s->progress; hide(c, s); }
    return r;
}

/* frame k (0..2) of the group: hold its Bayer buffer (see "hold instead of copy"); returns the frame's flags */
static u32 hold_frame(const struct ctx *c, struct state *s, u32 k, u8 *recipe, const u8 *si, u16 *bayer, u32 size, const s32 *q, struct frame_log *f)
{
    struct hslot *h = &s->hold[k];
    struct hold_log *L = &s->log.hold[k];
    u32 raw = rd32(recipe, R_BAYER_RAW), t, l, j;
    if (!ram((void *)raw) || raw > (u32)bayer || (u32)bayer + s->copy_bytes > raw + size) return F_GEOMETRY;   /* (ram(): 4-byte aligned) */
    pool(c, 1, &t, &l);
    f->img2_after = l;                       /* (mf13: IMAGE2's largest block at the decision) */
    if (l < size) return F_NO_MEMORY;        /* the next shot's Bayer buffer could not be had now: do not hold */
    if (__atomic_load_n(&h->word, __ATOMIC_SEQ_CST)) return F_NOSLOT;
    for (j = 0; j < GROUP - 1; j++) if (hold_raw(s, j) == raw) return F_NOSLOT;
    s->hpx[k] = (u8 *)bayer;
    for (j = 0; j < 32; j++) s->hsample[k][j] = f->px[j];
    s->canary[k] = canary(c, bayer, s->width, s->height);
    s->q[k][0] = q[0]; s->q[k][1] = q[1]; s->q[k][2] = q[2];
    s->hcf[k] = rd8(si, SI_HC);
    L->raw = raw; L->px = (u32)bayer; L->reg_tick = c->tick(s->timer); L->canary = s->canary[k];
    s->hdr[k] = L->hdr = rd32((const void *)(raw - 8), 0);
    h->site = 0; h->dup = 0; h->caller = 0;
    __atomic_store_n(&h->word, raw | H_HELD, __ATOMIC_SEQ_CST);
    return F_HELD;
}

/* mf17: a frame the back end does not take while the front end holds a burst's live-view restart (and no group is being
 * collected): the burst is not ours (a JPEG-only burst, ...), so the hold ends now instead of at the UI watchdog (35 s) */
static void not_ours(const struct ctx *c, struct state *s)
{
    if (s && s->lv_armed && s->phase != 1 && s->lv_armed == s->ab_burst) lv_release(c, s);
}

/* mf17 (HIDE_EARLY): frames 1..3 of an open group get no direct view (recipe+0xD = 1, as the stock 0x53735FA4 does), so that
 * during the merge no picture of an earlier frame stays on the screen and the 4th frame's own review comes after the merge.
 * Only a frame that is not the burst's last one: the front end has decided a later frame of this burst already (the last
 * frame keeps its display: its QUICK_VIEW_READY ends the App's wait).  hide: before | after << 8 | why << 16 */
#define HIDE_DONE 1u
#define HIDE_VT 2u
#define HIDE_SEQ 3u
#define HIDE_LAST 4u
#define HIDE_SET 5u
static void hide_frame(struct state *s, u8 *recipe, u32 seq, u32 k, struct mf_log *g)
{
    const u8 *vt = (const u8 *)rd32(recipe, 0);
    u32 before = rd8(recipe, R_DISP), why;
    if ((u32)vt != REC_VT) why = HIDE_VT;                         /* (only then is vt read: the image's own vtable) */
    else if (rd32(vt, 0x40) != REC_VT_SET || rd32(vt, 0x44) != REC_VT_GET) why = HIDE_VT;
    else if (!(seq == 0 || seq == 6)) why = HIDE_SEQ;
    else if (!(s->fe_burst == s->group_burst && s->fe_n >= k + 2)) why = HIDE_LAST;
    else if (before) why = HIDE_SET;
    else { *(volatile u8 *)(recipe + R_DISP) = 1; why = HIDE_DONE; }
    g->hide[k] = before | (u32)rd8(recipe, R_DISP) << 8 | why << 16;
}

/* mf17: the per-press log (struct press_log), frame 1's module 9 of every press with the switch on; never while shutting down */
static void press_log(const struct ctx *c, struct state *s, u8 *recipe, const u8 *si)
{
    struct press_log *Lp = &s->plog;
#define L (*Lp)
    const u8 *lvc = (const u8 *)s->lv_obj, *params = (const u8 *)rd32(recipe, R_PARAMS);
    u32 i, n;
    if (shutdown(s)) return;
    zero(&L, sizeof L);
    L.magic = PRESS_MAGIC; L.version = PRESS_VERSION; L.bytes = sizeof L; L.tick = c->tick(s->timer);
    L.since_end_us = s->last_end_tick ? us(c, s, s->last_end_tick, L.tick) : 0xffffffffu;
    L.fb_ret = s->fb_ret; L.fb_us = s->fb_ret && s->post_t0 ? pus(c, s, s->post_t0, s->fb_tick) : 0;
    n = s->post_n < POST_SAMPLES ? s->post_n : POST_SAMPLES; L.post_n = n;
    for (i = 0; i < n; i++) { L.post[i][0] = s->post[i][0]; L.post[i][1] = s->post[i][1]; L.post[i][2] = s->post[i][2]; }
    L.h1_seq = s->h1_seq; for (i = 0; i < H1_RING; i++) { L.h1[i] = s->h1[i]; L.h1_iso[i] = s->h1_iso[i]; }
    L.h2_seq = s->h2_seq; L.h2_cont = s->h2_cont; for (i = 0; i < H2_RING; i++) L.h2[i] = s->h2[i];
    L.mem_total_last = s->mem_total_last; L.mem_gate = s->mem_gate;
    pool(c, 1, &L.img2[0], &L.img2[1]);
    L.sv = rd32(si, SI_SV); L.tv = rd32(si, SI_TV); L.av = rd32(si, SI_AV); L.index = rd32(si, SI_INDEX); L.drive = rd8(si, SI_DRIVE);
    L.seqtype = rd32(recipe, R_SEQTYPE); L.develop = rd8(si, SI_DEVELOP); L.dng = ram(params) ? rd8(params, P_DNG) : 0xff;
    L.ev256 = ev_si(si); L.iso = iso_step(si);
    L.lv[0] = s->lv_armed; L.lv[1] = s->lv_deferred; L.lv[2] = ram(lvc) ? (u32)rd8(lvc, LV_RUNNING) | (u32)rd8(lvc, LVC_SHUT) << 8 : 0xffffu; L.lv[3] = s->ui_hold;
    L.fe_plans = fe_plans(s);
    L.nb_flags = rd8(c->user, NB_FLAGS); L.nd_dark = s->nd_dark; L.nd_switches = s->nd_switches; L.nd_ev = s->nd_ev;
    L.phase = s->phase; L.count = s->count; L.result_prev = s->log.result;
    copyw(&L.rv, &s->rv, sizeof L.rv);
    if (EV_LOG) ev_copy(c, s, &L.evl);
    L.asn_state = s->log.asn_state; copyw(L.asn1, s->log.asn1, sizeof L.asn1); copyw(L.asn4, s->log.asn4, sizeof L.asn4);
    copyw(L.bem, s->log.bem, sizeof L.bem);
    copyw(&L.dv, &s->dv, sizeof L.dv);
    if (write_file(c, 'P', L.tick, &L, sizeof L)) s->press_files++;
#undef L
}

/* mf19 (EV_LOG): the tick of a group frame's module 14 / 6 / 7 / 8 setup (its recipe and SI index as logged at module 9) */
static void be_mark(const struct ctx *c, struct state *s, u8 *recipe, u32 module)
{
    struct mf_log *g = &s->log;
    const u8 *si = (const u8 *)rd32(recipe, R_SI);
    u32 k, j = module == 14 ? 0 : module == 6 ? 1 : module == MOD_JPEG ? 2 : module == MOD_STORE ? 3 : 4;
    if (j > 3 || !ram(si) || !s->timer) return;
    for (k = 0; k < GROUP && k < g->frames; k++)
        if (g->f[k].recipe == (u32)recipe && g->f[k].index == rd32(si, SI_INDEX) && !g->bem[k][j]) { g->bem[k][j] = c->tick(s->timer); break; }
}

/* mf19 (ASN_FIRST): at the store's module setup (module 8; JPEG_ENC, module 7, came before), frame 1's AsShotNeutral words are
 * kept; the merged frame's are replaced by them (DNG value filler 0x53829454 reads SI+0x38BA4..0x38BC0 when the store writes the
 * DNG), only if frame 1's denominators are set */
static void asn_store(struct state *s, u8 *recipe)
{
    struct mf_log *g = &s->log;
    u8 *si = (u8 *)rd32(recipe, R_SI);
    u32 k;
    if (!ram(si)) return;
    if (s->asn_recipe == recipe && rd32(si, SI_INDEX) == s->asn_index && !s->asn1_ok) {
        for (k = 0; k < 8; k++) s->asn1[k] = rd32(si, SI_ASN + 4 * k);
        s->asn1_ok = 1; s->asn_recipe = 0;
        copyw(g->asn1, s->asn1, sizeof g->asn1);
    }
    if (!s->asnm_recipe || s->asnm_recipe != recipe) return;
    s->asnm_recipe = 0;
    if (rd32(si, SI_INDEX) != s->asnm_index) return;
    for (k = 0; k < 8; k++) g->asn4[0][k] = rd32(si, SI_ASN + 4 * k);
    if (!s->asn1_ok) g->asn_state = 2;
    else if (!s->asn1[1] || !s->asn1[3] || !s->asn1[7]) g->asn_state = 3;
    else {
        u32 same = 1;
        for (k = 0; k < 8; k++) { if (rd32(si, SI_ASN + 4 * k) != s->asn1[k]) same = 0; *(volatile u32 *)(si + SI_ASN + 4 * k) = s->asn1[k]; }
        g->asn_state = same ? 4 : 1;
    }
    for (k = 0; k < 8; k++) g->asn4[1][k] = rd32(si, SI_ASN + 4 * k);
}

/* ---- mf24 KEEP_LAST_ONLY --------------------------------------------------------------------------------------------------
 * The merge reads frames 1-3 from their held Bayer buffers inside frame 4's module 9 (the back end does nothing else meanwhile);
 * their store setups (module 8) come after it (camera mf21 / mf22: 9.4 .. 16.3 s after frame 4's module 9, i.e. when the back end
 * resumes).  At the group's end a merged group's frames that were used and whose store setup has not been seen yet are noted
 * (recipe, SI index); at their store setup (right after the stock SetupModuleConfig case 8 copied recipe+0x43 into the store
 * configuration's +0x72) the configuration byte is set to 1, the stock's "no file" request: the store handler then clears its
 * JPEG and RAW flags (0x537319C8 / 0x53731A58) and posts no item (no file, no file number).  Stored as stock instead: a group not
 * merged, a frame not used, a store set up before the result (seen), the power key / shutdown, later than KEEP_WAIT_US, the
 * handler's other path (SI+0xB16 and +0x73 set), a recipe that reached module 9 again (its frame is gone). */
enum { KP_NONE, KP_ENTRY, KP_SEEN, KP_DROP, KP_SHUT, KP_LATE, KP_PATH, KP_UNUSED, KP_GONE, KP_NOTMERGED,
       KP_FIRST,                         /* 10 (KEEP_FIRST): frame 1, no file, decided at its store setup (frame 2 in the group) */
       KP_FIRST_ONLY };                  /* 11: frame 1's store setup came while frame 1 was the group's only frame: stored */
static void keep_arm(struct state *s, u32 result)
{
    u32 k;
    s->kp_on = 0;
    for (k = 0; k < GROUP - 1; k++) {
        const struct frame_log *f = &s->log.f[k];
        u32 why;
        s->kp[k].recipe = 0;
        if (k >= s->log.frames) why = KP_NONE;
        else if (k == 0 && s->kp_first) why = s->kp_first;          /* KEEP_FIRST decided it at its store setup (whatever the result) */
        else if (result != R_MERGED) why = KP_NOTMERGED;
        else if (!(f->flags & F_USED)) why = KP_UNUSED;
        else if (s->kp_seen >> k & 1) why = KP_SEEN;
        else { s->kp[k].recipe = (u8 *)f->recipe; s->kp[k].index = f->index; s->kp_on = 1; why = KP_ENTRY; }
        s->kp_res[k] = why;
    }
    s->kp_seen = 0; s->kp_first = 0;
    s->kp_t0 = s->last_end_tick;
}

/* module 9 of any recipe: a noted recipe holds another frame now (its store came before the note, or never through here) */
static void keep_forget(struct state *s, const u8 *recipe)
{
    u32 k;
    for (k = 0; k < GROUP - 1; k++)
        if (s->kp[k].recipe == recipe) { s->kp[k].recipe = 0; if ((s->kp_res[k] & 0xff) == KP_ENTRY) s->kp_res[k] = KP_GONE; }
}

/* module 8 (STORE_IMG) setup of any recipe */
static void keep_store(const struct ctx *c, struct state *s, u8 *recipe)
{
    const u8 *si = (const u8 *)rd32(recipe, R_SI);
    u32 k, idx, t, why;
    if (!ram(si)) return;
    idx = rd32(si, SI_INDEX);
    if (s->phase == 1) {                                           /* the group still open: this store comes before the result */
        for (k = 0; k < GROUP - 1 && k < s->count; k++)
            if (s->log.f[k].recipe == (u32)recipe && s->log.f[k].index == idx) s->kp_seen |= 1u << k;
        if (KEEP_FIRST && (s->kp_seen & 1) && s->log.f[0].recipe == (u32)recipe && s->log.f[0].index == idx && !s->kp_first) {
            /* frame 1: no file if frame 2 is in the group already (see KEEP_FIRST), else stored (recorded) */
            t = s->log.f[0].tick ? us(c, s, s->log.f[0].tick, c->tick(s->timer)) : 0;
            if (s->count >= 2 && !s->shut && !shutdown(s) && rd32(recipe + REC_STORE_CFG, SC_SI) == (u32)si
                && !(rd8(si, SI_STORE_ALT) && rd8(recipe + REC_STORE_CFG, SC_MULTI))) {
                *(volatile u8 *)(recipe + REC_STORE_CFG + SC_NOFILE) = 1;
                s->kp_first = KP_FIRST;
            } else s->kp_first = s->count < 2 ? KP_FIRST_ONLY : (s->shut || shutdown(s)) ? KP_SHUT : KP_PATH;
            s->kp_first |= (t / 1000u < 0xffffffu ? t / 1000u : 0xffffffu) << 8;   /* ms after frame 1's module 9 */
        }
    }
    if (!s->kp_on) return;
    for (k = 0; k < GROUP - 1; k++) {
        if (s->kp[k].recipe != recipe || s->kp[k].index != idx) continue;
        s->kp[k].recipe = 0;
        t = us(c, s, s->kp_t0, c->tick(s->timer));
        if (s->shut || shutdown(s)) why = KP_SHUT;
        else if (t > KEEP_WAIT_US) why = KP_LATE;
        else if (rd32(recipe + REC_STORE_CFG, SC_SI) != (u32)si || (rd8(si, SI_STORE_ALT) && rd8(recipe + REC_STORE_CFG, SC_MULTI))) why = KP_PATH;
        else { *(volatile u8 *)(recipe + REC_STORE_CFG + SC_NOFILE) = 1; why = KP_DROP; }
        s->kp_res[k] = why | (t / 1000u < 0xffffffu ? t / 1000u : 0xffffffu) << 8;
    }
}

static void be(const struct ctx *c, u8 *recipe, u32 module)
{
    struct state *s;
    struct mf_log *g;
    struct frame_log *f;
    u8 *si, *info, *params;
    u16 *bayer;
    u32 seq, now, w, h, k, size, usable, idx;
    s32 q[3];
    if (module != 9) {
        /* a group that stopped short is closed at the next shot's first module */
        s = get_state(c, 0);
        if (PROBES && s && (*c->sw & SW_ON)) track(c, s, module);
        if (KEEP_LAST_ONLY && s && module == MOD_STORE) keep_store(c, s, recipe);   /* mf24: before anything else of the store setup */
        if (s) {
            eq_module(c, s, recipe, module);                       /* mf17: the merged frame's NR / ISO / white balance */
            if (EV_LOG) be_mark(c, s, recipe, module);            /* mf19 */
            if (ASN_FIRST && module == MOD_STORE) asn_store(s, recipe);
            if (s->log_due && us(c, s, s->log_due_tick, c->tick(s->timer)) > 5 * GAP_US) flush_log(c, s);
        }
        if (s && s->phase && us(c, s, s->last_tick, c->tick(s->timer)) > GAP_US) end_group(c, s, R_SHORT, 0);
        return;
    }
    s = get_state(c, 0);
    if (KEEP_LAST_ONLY && s) keep_forget(s, recipe);
    if (s) flush_log(c, s);                                        /* (a merged frame's log not written at its module 7) */
    if (!(*c->sw & SW_ON)) {
        if (s && s->phase) end_group(c, s, R_SWITCH_OFF, 0);
        not_ours(c, s);
        return;
    }
    si = (u8 *)rd32(recipe, R_SI);
    if (!ram(si) || rd8(si, SI_DEVELOP) != 0) { not_ours(c, s); return; }   /* RAW development and the like: not ours */
    seq = rd32(recipe, R_SEQTYPE);
    if (!(seq == 0 || seq == 1 || seq == 5 || seq == 6 || seq == 16)) { not_ours(c, s); return; }
    if (PRESS_LOG && rd32(si, SI_INDEX) == 0) {                    /* mf17: frame 1 of every press */
        s = get_state(c, 1);
        if (s && s->timer) press_log(c, s, recipe, si);
    }
    if (!gate_of(si)) {                                            /* below the gate (ISO and EV): not ours */
        if (s && s->phase) end_group(c, s, R_GATE, 0);
        not_ours(c, s);
        return;
    }
    s = get_state(c, 1);
    if (!s || !s->timer) return;
    now = c->tick(s->timer);
    params = (u8 *)rd32(recipe, R_PARAMS);
    if (s->phase && us(c, s, s->last_tick, now) > GAP_US) end_group(c, s, R_SHORT, 0);
    if (rd8(si, SI_DRIVE) != DRIVE_CONTINUOUS || !ram(params) || !rd8(params, P_DNG)) {
        if (s->phase) end_group(c, s, R_BROKEN, 0);
        not_ours(c, s);
        return;
    }
    if (s->mem_gate && rd32(si, SI_INDEX) == 0) {                  /* the front end stopped this shot at frame 1 for memory */
        s->mem_gate = 0; s->mem_skipped++;
        if (s->phase == 1) end_group(c, s, R_SHORT, 0);
        return;
    }
    if (s->phase == 2) { s->last_tick = now; s->tail++; return; }   /* frames 5.. of the burst: the camera's own */
    info = (u8 *)rd32(recipe, R_INFO);
    bayer = (u16 *)rd32(recipe, R_BAYER);
    w = ram(info) ? rd16(info, 0x20) : 0;
    h = ram(info) ? rd16(info, 0x22) : 0;
    size = rd32(recipe, R_BAYER_SIZE);
    g = &s->log;
    if (s->phase == 0) {
        zero(g, sizeof *g);
        take_prev(c, s, g);
        copyw(g->prev_keep, s->kp_res, sizeof g->prev_keep);       /* mf24 (the previous group's, complete by now as a rule) */
        g->tail_before = s->tail; s->tail = 0;
        s->phase = 1; s->count = 0;
        s->width = w; s->height = h; s->bayer_size = size;
        s->frame_bytes = w * h * 2; s->copy_bytes = (s->frame_bytes + 31) & ~31u;
        g->width = w; g->height = h; g->bayer_size = size;
        g->line = rd16(recipe, R_LINE);
        g->bayer_raw = rd32(recipe, R_BAYER_RAW);
        g->cfa = rd8(si, SI_CFA); g->bits = rd16(si, SI_BITS);
        for (idx = 0; idx < 4; idx++) g->black[idx] = rd32(si, SI_BLACK + 4 * idx);
        g->mode_before = (u32)*c->sw;
        g->iso_gate = ISO_GATE_STEP;
        g->hold_rule = size;
        s->wakes = 0;                        /* the UI task's indicator counters (written by it only while the spinner shows) */
        s->ui_draws = s->ui_first = s->ui_last = s->ui_max_gap = s->ui_vt_fail = s->ui_core = 0;
        s->ui_calls = s->ui_sample_tick = s->ui_nsamples = 0;
        s->group_burst = s->ab_burst; g->ab_group = s->ab_burst; g->ab_letter = s->ab_burst ? s->ab_letter : 0;
        s->wb_recipe = recipe; s->wb_index = rd32(si, SI_INDEX); s->wb1_ok = 0; s->v2_ok = 0;
        s->asn_recipe = recipe; s->asn_index = rd32(si, SI_INDEX); s->asn1_ok = 0; s->asnm_recipe = 0;   /* mf19 */   /* mf17: frame 1's gains at its Pipe1 */
        g->nb_flags = rd8(c->user, NB_FLAGS); g->tvmin = rd32(c->user - 4, CUR_TVMIN); g->isoup = rd32(c->user - 4, CUR_ISOUP);
        g->user_tvmin = rd16(c->user, NB_TV_LO) | (u32)rd16(c->user, NB_TV_HI) << 16;
        g->user_isoup = rd16(c->user, NB_UP_LO) | (u32)rd16(c->user, NB_UP_HI) << 16;
        __atomic_store_n(&s->active, 1u, __ATOMIC_SEQ_CST);
    }
    k = s->count;
    /* even sizes, the buffer large enough (with the 31 bytes the copy rounds up), the same as the group's first frame */
    usable = w >= 64 && h >= 64 && !(w & 1) && !(h & 1) && w <= 12000 && h <= 9000 && w == s->width && h == s->height && ram(bayer) &&
             !((u32)bayer & 15) && w * h * 2 + 32 <= size && size == s->bayer_size;
    q[0] = q3(rd32(si, SI_SV)); q[1] = q3(rd32(si, SI_TV)); q[2] = q3(rd32(si, SI_AV));
    f = &g->f[k];
    f->tick = now; f->gap_us = k ? us(c, s, s->last_tick, now) : 0;
    f->recipe = (u32)recipe; f->bayer = (u32)bayer; f->index = rd32(si, SI_INDEX); f->seqtype = seq;
    f->tv = rd32(si, SI_TV); f->av = rd32(si, SI_AV); f->sv = rd32(si, SI_SV); f->tv_us = rd32(si, SI_TV_US);
    f->white_si = rd32(si, SI_WHITE);
    g->ev256[k] = ev_si(si); g->gate[k] = gate_of(si);
    g->nr_frame[k] = (u32)rd8(params, P_NR) + 1;                  /* camera NR off on every frame of a group (the user's rule) */
    *(volatile u8 *)(params + P_NR) = 0;
    pool(c, 0, &f->img1_total, &f->img1_largest); pool(c, 1, &f->img2_total, &f->img2_largest);
    if (PROBES) {                            /* spec v9: the highlight-correction bytes and their neighbourhood, for the next camera run */
        struct hc_log *hl = &g->hc[k];
        hl->flags = rd8(si, SI_HC) | (u32)rd8(si, SI_HC_SET) << 8 | (round_black(si) >= 2048 ? 0x10000u : 0) | 0x1000000u;
        for (idx = 0; idx < 16; idx++) hl->si_b80[idx] = rd32(si, 0xb80 + 4 * idx);
        hl->si_7e0[0] = rd32(si, 0x7e0); hl->si_7e0[1] = rd32(si, 0x7e4);
    }
    if (PROBES && (k == 0 || k == GROUP - 1)) g->rec_n[k ? 1 : 0] = dump_recipes(&g->rec[k ? 1 : 0][0][0]);
    if (usable) sample(c, bayer, w, h, f->px, 1); else f->flags |= F_GEOMETRY;
    s->last_tick = now;
    s->count = k + 1;
    g->frames = k + 1;
    if (k < GROUP - 1) {
        u32 t0 = c->tick(s->timer);
        if (HIDE_EARLY) hide_frame(s, recipe, seq, k, g);
        if (!usable) return;
        f->flags |= hold_frame(c, s, k, recipe, si, bayer, size, q, f);
        f->chunk = hold_raw(s, k);           /* (mf13: the held allocation address, 0 if not held) */
        f->copy_us = us(c, s, t0, c->tick(s->timer));               /* (mf13: registration with its canary) */
        return;
    }
    if (usable) sync(c, bayer, s->copy_bytes);
    end_group(c, s, merge_group(c, s, recipe, si, bayer, q, usable), 1);
}

/* ---- the front end: one press, 4 frames ----------------------------------------------------------------------------- */

/* one entry of the front-end ring: also the ISO step and whether the gate answered (h1_iso, log version 8) */
static void h1_note(const struct ctx *c, struct state *s, u32 n, u32 stock, u32 answer, s32 iso, u32 gated)
{
    u32 i = s->h1_seq++ % H1_RING;
    s->h1[i].tick = c->tick(s->timer); s->h1[i].count = n; s->h1[i].stock = stock; s->h1[i].answer = answer;
    s->h1_iso[i] = ((u32)iso & 0xffffu) | (gated & 1 ? 0x10000u : 0) | (gated & 2 ? 0x20000u : 0);   /* bit 17: memory gate */
}

static u32 fe(const struct ctx *c, u8 *seq, u32 stock, const u8 *si)
{
    u32 n, answer;
    s32 iso;
    struct state *s;
    if (!(*c->sw & SW_ON)) return stock;
    iso = ram(si) ? iso_step(si) : 0;
    if (!ram(si) || !gate_of(si)) {                                /* below the gate (ISO, EV): an ordinary single shot */
        s = get_state(c, 0);                                       /* noted only if the state exists already (no allocation) */
        if (s) s->cont_n = 0;                                      /* (tap) H2 never continues a burst H1 ended */
        if (s && s->timer) h1_note(c, s, rd32(seq, 0x104), stock, 1, iso, 1);
        return 1;
    }
    n = rd32(seq, 0x104);
    answer = n < GROUP ? 0 : 1;
    s = get_state(c, 1);
    if (s && n == 1) {                                             /* frame 1: memory for 4 frames and the merge? */
        u32 t, l;
        pool(c, 1, &t, &l);
        s->mem_total_last = t;
        s->mem_gate = t < MEM_GATE_BYTES;
        if (s->mem_gate) { answer = 1; s->mem_gated++; }
        else { s->ab_burst = ++s->ab_count; s->ab_letter = 1u; }   /* mf13: live view held off for every group (mf12: A/B) */
    }
    if (s) {
        s->lv_seq = (u32)seq;
        s->fe_burst = s->ab_burst; s->fe_n = n;                    /* (mf17: which frames of the burst are not its last) */
        /* frame 4 (the stop decision): hold the burst's live-view restarts until its merge is over; mf17: not for a JPEG-only
         * burst (the back end never takes it) */
        if (n == GROUP && answer == 1 && s->ab_letter == 1 && s->ab_burst && s->timer && rd8(c->user - 4, CUR_FORMAT) != 0) {
            s->lv_arm_tick = now_p(c, s);
            s->lv_skips = 0;
            s->arm_h2 = s->h2_seq;
            __atomic_store_n(&s->lv_armed, s->ab_burst, __ATOMIC_SEQ_CST);
        }
    }
    if (s && s->timer) h1_note(c, s, n, stock, answer, iso, n == 1 && s->mem_gate ? 2 : 0);
    if (s) {                                                       /* (tap) what H2 checks: this continue, its count and tick */
        s->cont_n = 0;
        if (answer == 0 && s->timer) { s->cont_tick = s->h1[(s->h1_seq - 1) % H1_RING].tick; s->cont_seq = seq; s->cont_n = n; }
    }
    return answer;
}

/* H2 (which 3), step 0x206 of plan 1: the value the stock stores into SEQ+0xF2 (see the head of this file) */
static u32 tap(const struct ctx *c, u8 *seq, u32 regs, const u8 *si)
{
    u32 stock = regs & 0xffu, n, fl = 0, age = 0xffffffffu, answer = stock, i, now;
    struct state *s;
    if (!(*c->sw & SW_ON)) return stock;                           /* (the stub does not call with the switch off) */
    s = get_state(c, 0);                                           /* no allocation here */
    if (!s || !s->timer) return stock;
    now = c->tick(s->timer);
    n = rd32(seq, 0x104);
    if (stock) fl |= H2_STOCK;
    if (rd8(seq, 0xf8)) fl |= H2_F8;
    if (regs >> 8 & 0xffu) fl |= H2_F3;
    if (regs >> 16 & 0xffu) fl |= H2_11A;
    if (rd8(seq, 0x113)) fl |= H2_113;
    if (rd8(seq, 0x11e)) fl |= H2_11E;
    if (rd8(seq, 0x122)) fl |= H2_122;
    if (ram(si) && rd8(si, SI_DRIVE) == DRIVE_CONTINUOUS) fl |= H2_DRIVE;
    if (n >= 1 && n <= GROUP - 1) fl |= H2_COUNT;
    if (s->cont_n && s->cont_seq == seq && s->cont_n == n) {
        fl |= H2_MATCH;
        age = pus(c, s, s->cont_tick, now);
        if (age < TAP_LIMIT_US) fl |= H2_YOUNG;
        else s->cont_n = 0;                                        /* over the limit: for good (no wrap of the counter revives it) */
    }
    if ((fl & (H2_STOCK | H2_F8 | H2_DRIVE | H2_COUNT | H2_MATCH | H2_YOUNG)) == (H2_STOCK | H2_F8 | H2_DRIVE | H2_COUNT | H2_MATCH | H2_YOUNG) &&
        !(fl & (H2_F3 | H2_11A | H2_113 | H2_11E | H2_122))) {
        answer = 0; fl |= H2_CONT; s->h2_cont++;
    }
    i = s->h2_seq++ % H2_RING;
    s->h2[i].tick = now; s->h2[i].count = n; s->h2[i].flags = fl; s->h2[i].answer = answer; s->h2[i].age_us = age;
    return answer;
}

/* ---- the menu switch (UI task) ------------------------------------------------------------------------------------- */

static u8 *cur(const struct ctx *c) { c->ui_prep(); return c->current(); }

/* ---- mf17 night mode: our values in the settings and their way back ---------------------------------------------------
 * NIGHT_LIMITS: while the switch is on, CUR+0x108 (auto-ISO slowest shutter) = 1/30 s and CUR+0x100 (auto-ISO upper limit) at
 * least ISO 25600, set with the stock setters from the UI task; the user's two values are kept in padding bytes of the saved
 * settings (NB_*), with the flag NBF_LIM.  NIGHT_DRIVE: in single drive, the live view's rule switches the drive to continuous
 * (NBF_DRV) and back.  The settings reach the card only at power-off (CMD_SYSTEM_SHUTDOWN -> 0x533F3674, UI task, which copies
 * CUR + 4; no per-setter or periodic save, docs T7n): there save_hook writes the user's values back into CUR first and clears
 * the flags, so our values are never saved as the user's (a battery pull saves nothing: the last clean power-off's file stays);
 * after the next power-on the UI applies them again.  Switch off: put back with the setters, each only if it still has our
 * value (a value the user changed meanwhile stays). */
static u32 nb_get32(const struct ctx *c, u32 lo, u32 hi) { return rd16(c->user, lo) | (u32)rd16(c->user, hi) << 16; }
static void nb_put32(const struct ctx *c, u32 lo, u32 hi, u32 v)
{
    *(volatile u16 *)(c->user + lo) = (u16)v; *(volatile u16 *)(c->user + hi) = (u16)(v >> 16);
}
static void nb_flags(const struct ctx *c, u32 v) { *(volatile u8 *)(c->user + NB_FLAGS) = (u8)v; }
static void setf(fset_t f, u8 *k, u32 bits) { union { u32 u; float f; } v; v.u = bits; f(k, v.f); }

static void limits_on(const struct ctx *c)
{
    u8 *k = c->user - 4;
    u32 tv = rd32(k, CUR_TVMIN), up = rd32(k, CUR_ISOUP);
    if (rd8(c->user, NB_FLAGS) & NBF_LIM) return;
    nb_put32(c, NB_TV_LO, NB_TV_HI, tv); nb_put32(c, NB_UP_LO, NB_UP_HI, up);
    nb_flags(c, rd8(c->user, NB_FLAGS) | NBF_LIM);
    if (tv != TV_NIGHT) setf(c->set_tvmin, cur(c), TV_NIGHT);
    if (!(up >> 31) && up < SV_NIGHT) setf(c->set_isoup, cur(c), SV_NIGHT);    /* raised only (positive floats order as integers) */
}

/* with the setters (UI task) or, at the settings save, straight into CUR (direct) */
static void limits_off(const struct ctx *c, u32 direct)
{
    u8 *k = c->user - 4;
    u32 tv = nb_get32(c, NB_TV_LO, NB_TV_HI), up = nb_get32(c, NB_UP_LO, NB_UP_HI);
    if (!(rd8(c->user, NB_FLAGS) & NBF_LIM)) return;
    if (rd32(k, CUR_TVMIN) == TV_NIGHT && tv != TV_NIGHT) { if (direct) *(volatile u32 *)(k + CUR_TVMIN) = tv; else setf(c->set_tvmin, cur(c), tv); }
    if (rd32(k, CUR_ISOUP) == SV_NIGHT && up != SV_NIGHT) { if (direct) *(volatile u32 *)(k + CUR_ISOUP) = up; else setf(c->set_isoup, cur(c), up); }
    nb_flags(c, rd8(c->user, NB_FLAGS) & ~NBF_LIM);
}

static void drive_back(const struct ctx *c, u32 direct)
{
    u8 *k = c->user - 4;
    if (!(rd8(c->user, NB_FLAGS) & NBF_DRV)) return;
    if (rd8(k, CUR_DRIVE) == DRIVE_CONTINUOUS) { if (direct) *(volatile u8 *)(k + CUR_DRIVE) = 0; else c->set_drive(cur(c), 0); }
    nb_flags(c, rd8(c->user, NB_FLAGS) & ~NBF_DRV);
}

/* mf22 NIGHT_REVIEW: Display Time codes kept in NB_FLAGS bits 3..5 (1..6; 0 none) */
static u32 rv_code(u32 ms)
{
    return ms == 0 ? 1 : ms == 500 ? 2 : ms == 1000 ? 3 : ms == 2000 ? 4 : ms == 3000 ? 5 : ms == 0xffffffffu ? 6 : 0;
}
static u32 rv_ms(u32 code)
{
    return code == 1 ? 0 : code == 2 ? 500 : code == 3 ? 1000 : code == 4 ? 2000 : code == 5 ? 3000 : code == 6 ? 0xffffffffu : 0xfffffffeu;
}
/* the user's Display Time: the kept value while ours is in CUR, else the camera's own */
static u32 user_review_ms(const struct ctx *c)
{
    u32 fl = rd8(c->user, NB_FLAGS);
    if (NIGHT_REVIEW && (fl & NBF_RV)) return rv_ms(fl >> NBF_RV_SHIFT & 7);
    return rd32(c->user - 4, CUR_REVIEW);
}

/* mf22 NIGHT_REVIEW: Display Time Off while the switch is on (UI task, same moments as the limits).  The user's value as a code in
 * NB_FLAGS bits 3..5 with NBF_RV; a value the menu cannot give (no code) is left alone.  Off / the save: put back only if CUR+0x914
 * is still 0 (ours); a value the user picked meanwhile stays.  At the save (direct) only CUR+0x914, what the save copies (the
 * copy +0x1458 is rebuilt from it at the next set; the next UI tick sets Off again if the camera goes on). */
static void review_on(const struct ctx *c)
{
    u8 *k = c->user - 4;
    u32 fl = rd8(c->user, NB_FLAGS), v = rd32(k, CUR_REVIEW_SET), code = rv_code(v);
    if ((fl & NBF_RV) || !code) return;
    nb_flags(c, (fl & ~(7u << NBF_RV_SHIFT)) | NBF_RV | code << NBF_RV_SHIFT);
    if (v != 0 || rd32(k, CUR_REVIEW) != 0) c->set_review(cur(c), 0);
}

static void review_off(const struct ctx *c, u32 direct)
{
    u8 *k = c->user - 4;
    u32 fl = rd8(c->user, NB_FLAGS), v = rv_ms(fl >> NBF_RV_SHIFT & 7);
    if (!(fl & NBF_RV)) return;
    if (rd32(k, CUR_REVIEW_SET) == 0 && v != 0 && v != 0xfffffffeu) {
        if (direct) *(volatile u32 *)(k + CUR_REVIEW_SET) = v; else c->set_review(cur(c), v);
    }
    nb_flags(c, rd8(c->user, NB_FLAGS) & ~(NBF_RV | 7u << NBF_RV_SHIFT));
}

/* which 4: the stock settings save 0x533F3674 at power-off (UI task), before it copies CUR + 4 */
static void save_hook(const struct ctx *c)
{
    limits_off(c, 1);
    drive_back(c, 1);
    review_off(c, 1);
}

static void restore(const struct ctx *c, u32 saved)
{
    u32 d = (saved >> 1) & 7, f = (saved >> 4) & 3, l = (saved >> 6) & 3;
    u8 *k = c->current();
    if (rd8(k, CUR_LNR) == LNR_OFF && l != LNR_OFF) c->set_lnr(cur(c), l);
    k = c->current();
    if (rd8(k, CUR_FORMAT) == FORMAT_RAW_JPEG && f != FORMAT_RAW_JPEG) c->set_format(cur(c), f);
    k = c->current();
    if (!NIGHT_DRIVE && rd8(k, CUR_DRIVE) == DRIVE_CONTINUOUS && d != DRIVE_CONTINUOUS) c->set_drive(cur(c), d);
    if (NIGHT_DRIVE) drive_back(c, 0);
    limits_off(c, 0);
    review_off(c, 0);
}

static void ui(const struct ctx *c, u32 value)
{
    u32 b = *c->sw, d, f, l;
    u8 *k;
    struct state *s;
    if (value > 1) return;
    if (value == 1 && !(b & SW_ON)) {
        k = c->current();
        d = rd8(k, CUR_DRIVE); f = rd8(k, CUR_FORMAT); l = rd8(k, CUR_LNR);
        if (d > 5 || f > 2 || l > 2) return;
        b = SW_ON | d << 1 | f << 4 | l << 6;
        *c->sw = (u8)b;
        c->set_format(cur(c), FORMAT_RAW_JPEG);
        c->set_lnr(cur(c), LNR_OFF);
        c->set_timer(cur(c), 0);
        if (!NIGHT_DRIVE) {                  /* mf16: continuous; mf17: the drive stays (the live view's rule switches single) */
            c->set_drive(cur(c), DRIVE_CONTINUOUS);
            k = c->current();
            if (rd8(k, CUR_DRIVE) != DRIVE_CONTINUOUS || rd8(k, CUR_DRIVE_LIVE) != DRIVE_CONTINUOUS) {
                *c->sw = 0;                 /* the camera refused continuous here: put everything back, the switch stays off */
                restore(c, b);
            }
        }
    } else if (value == 0 && (b & SW_ON)) {
        *c->sw = 0;
        restore(c, b);
        s = get_state(c, 0);
        if (s) __atomic_store_n(&s->ui_hold, 0u, __ATOMIC_SEQ_CST);
    }
}

/* the live view's exposure: EV100 x 256 from the AE's published Tv / Av / Sv (ComPropIf E = [slot], vtable 0x53FC54D8,
 * X = [E+0x518], D = X[0], D+0x4D8 / 4DC / 4E0, read twice and accepted only when both reads agree; exposure.md, migration-120);
 * 0x7fffffff when not available */
static s32 live_ev(const struct ctx *c)
{
    const u8 *e = (const u8 *)*(volatile u32 *)c->comprop, *x, *d;
    u32 t, a, v, i;
    for (i = 0; i < 2; i++) {
        if (!ram(e) || rd32(e, 0) != 0x53fc54d8u) return 0x7fffffff;
        x = (const u8 *)rd32(e, 0x518);
        if (!ram(x)) return 0x7fffffff;
        d = (const u8 *)rd32(x, 0);
        if (!ram(d)) return 0x7fffffff;
        t = rd32(d, 0x4d8); a = rd32(d, 0x4dc); v = rd32(d, 0x4e0);
        if (rd32(x, 0) == (u32)d && rd32(d, 0x4d8) == t && rd32(d, 0x4dc) == a && rd32(d, 0x4e0) == v) {
            if (!t && !a && !v) return 0x7fffffff;
            return ev_of(a, t, v);
        }
    }
    return 0x7fffffff;
}

/* mf18 (REVIEW_ARM, UI task, every loop with the switch on): a merged group's end (rv_req, back end) puts CaptureImageModel
 * +0x27 back to 1 (the stock release's own write, 0x533EAD3C, event 0x14C) if CIM is constructed, the shooting screen is up,
 * +0x27 and +0x24 are 0, no group is active and the camera does not shut down.  Nothing else: frame 4's QUICK_VIEW_READY then
 * finds +0x27 set (0x533EAB6C sets +0x24), CaptureReadyModel's decision 0x533A2714 posts 0x94 (the timed review, review time
 * CUR +0x1458) instead of 0xC8 (whose handler 0x5325D0E8 does nothing while +0x27 = 0: the picture stayed, camera mf13..mf17),
 * and the review's end (0x531EAF2C, 0x531EB268 -> 0x533EAFDC) takes the picture away [E stock chain, docs T7o].  Then the
 * watch for REVIEW_WATCH_US: when +0x24 / +0x27 / the screen / live view change, the longest pause of this loop. */
static void rv_tick(const struct ctx *c, struct state *s, u32 now)
{
    struct rv_watch *v = &s->rv;
    u8 *cim = (u8 *)CIM_OBJ;
    const u8 *lvc = (const u8 *)s->lv_obj, *q;
    u32 screen, cim_ok, f24, f27, lv, t, gap;
    if (__atomic_exchange_n(&s->rv_req, 0u, __ATOMIC_SEQ_CST)) {
        zero(v, sizeof *v);
        v->on = 1; v->tick_last = now;
        v->arm_us = pus(c, s, s->rv_t0, now) + 1;
        v->review_ms = rd32(c->user - 4, CUR_REVIEW);
        q = (const u8 *)c->app_queue(); screen = q ? rd32(q, 0) : 0;
        if (shutdown(s)) v->ret = 0xeee6;
        else if (s->active) v->ret = 0xeee1;
        else if (!(rd32((const void *)CIM_GUARD, 0) & 1)) v->ret = 0xeeef;
        else if (screen != SCREEN_SHOOT) v->ret = 0xeee5;
        else if (REVIEW_ARM && rd8(cim, 0x27)) v->ret = 0xeee3;
        else if (REVIEW_ARM && rd8(cim, 0x24)) v->ret = 0xeee4;
        else if (!REVIEW_ARM) v->ret = 0xeee0 | (u32)rd8(cim, 0x27) << 16;   /* (mf19: watch only; +0x27 as found) */
        else {
            *(volatile u8 *)(cim + 0x27) = 1;
            v->ret = 1u | (u32)rd8(cim, 0x27) << 8 | (u32)rd8(cim, 0x24) << 16;
        }
    }
    if (!v->on) return;
    t = pus(c, s, s->rv_t0, now);
    if (t >= REVIEW_WATCH_US || s->active) { v->on = 0; v->end_us = t + 1; return; }
    gap = pus(c, s, v->tick_last, now);                          /* (equal readings: 0, not a whole turn) */
    if (gap > v->gap_us) { v->gap_us = gap; v->gap_at_us = t - gap + 1; }
    v->tick_last = now; v->calls++;
    q = (const u8 *)c->app_queue(); screen = q ? rd32(q, 0) : 0;
    cim_ok = rd32((const void *)CIM_GUARD, 0) & 1;
    f24 = cim_ok ? rd8(cim, 0x24) : 0xff; f27 = cim_ok ? rd8(cim, 0x27) : 0xff;
    lv = ram(lvc) ? rd8(lvc, LV_RUNNING) : 0xff;
    if (f24 == 1 && !v->t24_us) v->t24_us = t + 1;
    if (f27 == 0 && ((v->ret & 0xff) == 1 || (v->last >> 8 & 0xff) == 1) && !v->t27off_us) v->t27off_us = t + 1;   /* (mf19: any 1 -> 0) */
    if (screen != SCREEN_SHOOT && !v->tscreen_us) { v->tscreen_us = t + 1; v->screen = screen; }
    if (screen == SCREEN_SHOOT && !v->tback_us && (v->tscreen_us || gap >= 1000000u)) v->tback_us = t + 1;
    if (lv == 1 && !v->tlv_us) v->tlv_us = t + 1;
    v->last = (f24 & 0xff) | (f27 & 0xff) << 8 | (lv & 0xff) << 16 | (u32)(screen == SCREEN_SHOOT) << 24;
}

/* mf21 helpers: the LCD's ScreenDevice layer bytes (+0x3F / +0x40 / +0x41 valid, +0xAA / +0xB1 / +0xB9 direct draw), the still back
 * end's display bytes (+0xCBC, +0xCBD, +0x2DE); 0xffffffff when the object is not there */
static const u8 *lcd_dev(void) { const u8 *d = (const u8 *)rd32((const void *)LCD_SLOT, 0); return ram(d) ? d : 0; }
static u32 lcd_word(void) { const u8 *d = lcd_dev(); return d ? (u32)rd8(d, 0x3f) | (u32)rd8(d, 0x40) << 8 | (u32)rd8(d, 0x41) << 16 | (u32)rd8(d, 0xaa) << 24 : 0xffffffffu; }
static u32 lcd_word2(void) { const u8 *d = lcd_dev(); return d ? (u32)rd8(d, 0xb1) | (u32)rd8(d, 0xb9) << 8 : 0xffffffffu; }
static u32 be_word(void)
{
    const u8 *b = (const u8 *)BE_OBJ;
    if (!(rd32((const void *)BE_GUARD, 0) & 1)) return 0xffffffffu;
    return (u32)rd8(b, 0xcbc) | (u32)rd8(b, 0xcbd) << 8 | (u32)rd8(b, 0x2de) << 16;
}
static u32 cim_word(void)
{
    const u8 *m = (const u8 *)CIM_OBJ;
    if (!(rd32((const void *)CIM_GUARD, 0) & 1)) return 0xffffffffu;
    return (u32)rd8(m, 0x24) | (u32)rd8(m, 0x25) << 8 | (u32)rd8(m, 0x26) << 16 | (u32)rd8(m, 0x27) << 24;
}

/* mf21 (UI task, every loop with the switch on; docs T7r).
 *  A (OSD_UNHIDE): while the merge runs (busy), CIM constructed, the shooting screen up, LiveViewControl known and not shutting
 *    down: the full-screen panel is requested (osd_full) and, if +0x25 = 1 and +0x27 = 0, +0x25 is written 0 (the stock's own
 *    clears: 0x2448020B / event 0x36).  Only while busy: the merged frame's direct view comes after the merge (the back end is
 *    in our module until then) and sets +0x25 again; it is never cleared after the merge.
 *  D: our 0 is "held" until the stock writes +0x25 again (2); at a release start (+0x27 0 -> 1) a held 0 is put back to 1 if the
 *    LCD's layer 0 is still in direct draw (the stock's state for a picture on screen) (4); OSD_GUARD_US after the merge the same (3),
 *    or left (5: no picture).  osd_full only while busy.
 *  B (REVIEW_END): see the switch; the BE bytes are put back once the back end took the command; a release start does the same.
 *  The window after every group: samples (CIM, LCD, BE words) every 0.5 s for 10 s. */
/* mf23 PROC_SCREEN helpers: the LiveViewController the per-loop wrapper noted (its vtable checked), giving +0x4E5 back */
static u8 *ps_ctrl(const struct state *s)
{
    u8 *k = (u8 *)s->ev_ctrl;
    u32 vt;
    if (!ram(k) || ((u32)k & 3)) return 0;
    vt = rd32(k, 0);
    return vt == LVC_VT ? k : 0;
}
static u32 crm_b(void) { return (rd32((const void *)CRM_GUARD, 0) & 1) ? rd8((const void *)CRM_OBJ, 0xb) : 0xffu; }
static void ps_back(const struct ctx *c, struct state *s, struct dv_watch *d, u32 why, u32 now)
{
    u8 *k = s->ps_ctrl_p;
    if (!s->ps_ours) return;
    s->ps_ours = 0;
    if (ram(k) && rd32(k, 0) == LVC_VT && rd8(k, LVC_HIDE) == 0) *(volatile u8 *)(k + LVC_HIDE) = 1;
    else why |= 0x10;
    d->ps_back = why; d->ps_back_us = (s->dv_busy_t0 ? pus(c, s, s->dv_busy_t0, now) : 0) + 1;
}

static void dv_tick(const struct ctx *c, struct state *s, u32 now)
{
    struct dv_watch *d = &s->dv;
    u8 *cim = (u8 *)CIM_OBJ;
    const u8 *lvc = (const u8 *)s->lv_obj, *q;
    u32 busy = __atomic_load_n(&s->busy, __ATOMIC_SEQ_CST), screen, cim_ok, f25, f27, lcd, req, t, full = 0, rel, i;
    q = (const u8 *)c->app_queue(); screen = q ? rd32(q, 0) : 0;
    cim_ok = rd32((const void *)CIM_GUARD, 0) & 1;
    f25 = cim_ok ? rd8(cim, 0x25) : 0xff; f27 = cim_ok ? rd8(cim, 0x27) : 0xff;
    rel = cim_ok && f27 == 1 && s->dv_27 == 0;                    /* a release start (event 0x14C) since the last loop */
    s->dv_27 = f27;
    if (busy && !s->shut) {
        if (!s->dv_busy) {                                         /* the merge's first loop: the previous window is over */
            copyw(&s->dv_prev, d, sizeof *d); zero(d, sizeof *d);
#if PROBES
            s->rd_n = 0;
#endif
            s->dv_busy = 1; s->dv_busy_t0 = now; s->dv_end_t0 = 0; s->dv_posted = 0;
            __atomic_store_n(&s->dv_req, 0u, __ATOMIC_SEQ_CST);
        }
        d->osd_ticks++;
        if (PROC_SCREEN) {
            u8 *k = ps_ctrl(s);
            u32 lw = lcd_word(), aa = lw != 0xffffffffu ? lw >> 24 : 0xffu, why;
            why = !cim_ok ? 4 : screen != SCREEN_SHOOT ? 2 : (!ram(lvc) || rd8(lvc, LVC_SHUT) || shutdown(s)) ? 8 : 0;
            if (!why) why = f27 ? 1 : f25 ? 16 : aa != 0 ? 32 : !k ? 64 : (fe_plans(s) & 0x3f) ? 128 : 0;
            if (!why) {
                if (rd8(k, LVC_HIDE) == 1) {
                    *(volatile u8 *)(k + LVC_HIDE) = 0;
                    if (!s->ps_ours) { s->ps_ours = 1; s->ps_ctrl_p = k; d->ps_ctrl = (u32)k; }
                    d->ps_n++;
                    if (!d->ps_first_us) d->ps_first_us = pus(c, s, s->dv_busy_t0, now) + 1;
                } else if (!s->ps_ours) why = 256;
                if (s->ps_ours) full = 1;
            } else if (s->ps_ours) ps_back(c, s, d, (why & 1) ? 2 : (why & 8) ? 3 : (why & 6) ? 4 : 5, now);
            if (why && !s->ps_ours) d->ps_skip |= why;
            if (PROBES && d->mn < MSMP_N && pus(c, s, s->dv_busy_t0, now) >= d->mn * 500000u) {
                u32 *e = d->msmp[d->mn++];
                e[0] = pus(c, s, s->dv_busy_t0, now) + 1; e[1] = lw;
                e[2] = (k ? rd8(k, LVC_HIDE) : 0xfu) | s->ps_ours << 4 | crm_b() << 8 | (f25 & 0xff) << 16 | (f27 & 0xff) << 24;
#if PROBES
                if (s->rd_n < MSMP_N) {          /* the appended code's counters (handnight.ts PROBES 1: +0x50, +0x10, +0x54 | +0x58 << 16) */
                    u32 *x = s->rd[s->rd_n++];
                    x[0] = s->ui_calls; x[1] = s->ui_draws; x[2] = (s->ui_sample_tick & 0xffffu) | s->ui_nsamples << 16;
                }
#endif
            }
        }
        if (OSD_UNHIDE) {
            u32 why = !cim_ok ? 4 : screen != SCREEN_SHOOT ? 2 : (!ram(lvc) || rd8(lvc, LVC_SHUT) || shutdown(s)) ? 8 : 0;
            if (!why) {
                full = 1; d->osd_full_n++;
                if (f25 == 1 && f27 == 0) {
                    *(volatile u8 *)(cim + 0x25) = 0;
                    d->osd_n++; d->held = 1; d->held_us = 0;
                    t = pus(c, s, s->dv_busy_t0, now) + 1;
                    if (!d->osd_first_us) d->osd_first_us = t;
                    d->osd_last_us = t;
                } else if (f25 == 1) why = 1;
                else if (f25 == 0 && !d->osd_n) why = 16;
            }
            d->osd_skip |= why;
        }
    } else if (s->dv_busy) {                                       /* the first loop after the merge (or the power key) */
        s->dv_busy = 0; s->dv_end_t0 = now;
        if (PROBES) { d->at_end = cim_word(); d->lcd_end = lcd_word(); d->lcd2_end = lcd_word2(); }
        if (PROC_SCREEN) ps_back(c, s, d, (s->shut || shutdown(s)) ? 3 : 1, now);
    }
    if (PROC_SCREEN && s->ps_ours && (!busy || s->shut)) ps_back(c, s, d, 6, now);   /* (fallback: never ours outside the merge) */
    if (LOG_DEFER && rel) __atomic_store_n(&s->dv_rel, 1u, __ATOMIC_SEQ_CST);
    __atomic_store_n(&s->osd_full, full, __ATOMIC_SEQ_CST);
    if ((req = __atomic_exchange_n(&s->dv_req, 0u, __ATOMIC_SEQ_CST))) {
        d->on = 1; d->result = req; d->n = 0;
        s->dv_ev0 = s->ev_n; s->dv_scan = s->ev_keys; s->dv_tshow = 0; s->dv_posted = 0; s->dv_aa0 = 0;   /* (mf24: the key count) */
        if (rel) __atomic_store_n(&s->dv_rel, 1u, __ATOMIC_SEQ_CST);
        d->re_ret = (req & 0xff) != R_MERGED ? 0xeee9u : !REVIEW_END ? 0xeee0u : 0;
        if (PROBES) {
            d->rvs_flags = rd8(c->user, NB_FLAGS);
            d->rvs_user_ms = (d->rvs_flags & NBF_RV) ? rv_ms(d->rvs_flags >> NBF_RV_SHIFT & 7) : 0xfffffffeu;
            d->rvs_set_ms = rd32(c->user - 4, CUR_REVIEW_SET); d->rvs_rt_ms = rd32(c->user - 4, CUR_REVIEW);
        }
    }
    /* D: our 0 (only OSD_UNHIDE writes one) */
    if (d->held == 1 && !busy) {
        t = s->dv_t0 ? pus(c, s, s->dv_t0, now) + 1 : 1;
        if (f25 == 1) { d->held = 2; d->held_us = t; }
        else if (rel || (s->dv_end_t0 && pus(c, s, s->dv_end_t0, now) >= OSD_GUARD_US)) {
            lcd = lcd_word();
            if (cim_ok && f25 == 0 && lcd != 0xffffffffu && (lcd >> 24) == 1) { *(volatile u8 *)(cim + 0x25) = 1; d->held = rel ? 4 : 3; }
            else d->held = rel ? 6 : 5;
            d->held_us = t;
        }
    }
    if (!d->on) return;
    t = pus(c, s, s->dv_t0, now);
    lcd = lcd_word();
    if (s->dv_posted == 1) {                                       /* B: after the post, record only (no second post) */
        if (PROBES && lcd != 0xffffffffu && (lcd >> 24) == 0 && !d->re_gone_us) d->re_gone_us = t + 1;
        if (pus(c, s, s->dv_tpost, now) >= RE_CHECK_US || s->active || busy) {
            if (PROBES) {
                d->re_be[1] = be_word(); d->re_be[2] = cim_word(); d->re_chk_lcd = lcd;
                d->re_chk_lv = (ram(lvc) ? rd8(lvc, LV_RUNNING) : 0xffu) | (u32)(screen == SCREEN_SHOOT) << 8 | (f27 & 0xff) << 16;
            }
            s->dv_posted = 2;
        }
    }
    if (s->active || busy) {                                       /* the next group: the window ends */
        if (!d->re_ret) d->re_ret = 0xeee1;
        d->on = 0; return;
    }
    if (PROBES && d->n < DV_SAMPLES && t >= d->n * (REVIEW_WATCH_US / DV_SAMPLES)) {
        u32 *e = d->smp[d->n++];
        e[0] = t + 1; e[1] = cim_word(); e[2] = lcd;
        e[3] = (lcd_word2() & 0xffffu) | (ram(lvc) ? (u32)rd8(lvc, LV_RUNNING) : 0xffu) << 16 | (u32)(screen == SCREEN_SHOOT) << 24;
        e[4] = be_word();
    }
    if (REVIEW_END && !d->re_ret) {
        u32 aa = lcd != 0xffffffffu ? lcd >> 24 : 0xffu;
        if (aa == 0) s->dv_aa0 = 1;
        if (shutdown(s)) d->re_ret = 0xeee6;
        else if (rel || f27 == 1) d->re_ret = 0xeee1;
        else if (__atomic_load_n(&s->ev_keys, __ATOMIC_SEQ_CST) != s->dv_scan) d->re_ret = 0xeee2;   /* a switch (a key) after the group's
                                                                       end, the user's / the stock's (mf24: the dispatch stub's count;
                                                                       mf22 / mf23 scanned the event ring for App events 1..0x2D) */
        if (!d->re_ret && !s->dv_tshow) {                         /* the merged frame on screen: layer 0 in direct draw after the end */
            if (aa == 1 && (s->dv_aa0 || t >= RE_SHOW_US)) {
                s->dv_tshow = now; d->re_shown_us = t + 1;
                d->re_review_ms = user_review_ms(c);
                if (d->re_review_ms == 0xffffffffu) d->re_ret = 0xeee7;
                else if (d->re_review_ms > 60000u) d->re_review_ms = 500;   /* (no such menu value: the camera's shortest) */
            } else if (t >= RE_WAIT_US) d->re_ret = 0xeee8;
        }
        if (!d->re_ret && s->dv_tshow && pus(c, s, s->dv_tshow, now) >= d->re_review_ms * 1000u) {
            if (!cim_ok) d->re_ret = 0xeeef;
            else if (screen != SCREEN_SHOOT) d->re_ret = 0xeee5;
            else if (aa != 1) d->re_ret = 0xeee4;
            else if (!ram(lvc) || rd8(lvc, LVC_SHUT)) d->re_ret = 0xeee6;
            else {
                u32 fz[2] = {0, 0};
                void *m = c->pb_model();
                s32 r;
                if (PROBES) d->re_be[0] = be_word();
                r = m ? c->pb_post(m, CMD_DQV_STOP, 0, 0, fz) : -1;
                s->dv_posted = 1; s->dv_tpost = now;
                d->re_ret = 1u | ((u32)r & 0xffff) << 8; d->re_post_us = t + 1;
            }
        }
    }
    if (t >= REVIEW_WATCH_US && (d->n >= DV_SAMPLES || !PROBES) && (d->re_ret || !REVIEW_END) && s->dv_posted != 1) d->on = 0;
    (void)i;
}

/* which 5 (UI task, the live view's per-loop update, switch on): the UI watchdog's guards, the limits, the drive rule */
static void ui_tick(const struct ctx *c)
{
    struct state *s;
    u8 *k = c->user - 4, *q;
    u32 now, screen, fl, drv, hold = 0;
    s32 ev;
    if (!(*c->sw & SW_ON)) return;
    s = get_state(c, 1);
    if (!s || !s->timer) return;
    s->ui_ticks++;
    now = c->tick(s->timer);
    if (REVIEW_ARM || RV_WATCH) rv_tick(c, s, now);
    dv_tick(c, s, now);
    if (__atomic_load_n(&s->lv_deferred, __ATOMIC_SEQ_CST) && s->lv_armed && !s->busy) {
        if (shutdown(s)) {                                         /* no restart while shutting down */
            __atomic_store_n(&s->lv_armed, 0u, __ATOMIC_SEQ_CST);
            if (__atomic_exchange_n(&s->lv_deferred, 0u, __ATOMIC_SEQ_CST)) __atomic_store_n(&s->lv_ui_net, LV_NET_UI | LV_NET_SHUT, __ATOMIC_SEQ_CST);
        } else if (s->h2_seq != s->arm_h2 && (fe_plans(s) & 0x3f)) hold = 1;   /* a shot in progress: it restarts live view */
    }
    __atomic_store_n(&s->ui_hold, hold, __ATOMIC_SEQ_CST);
    q = (u8 *)c->app_queue();
    screen = q ? rd32(q, 0) : 0;
    if (screen != SCREEN_SHOOT || s->active || s->busy || rd8(k, CUR_STILL) || shutdown(s)) return;
    if (NIGHT_LIMITS) limits_on(c);
    if (NIGHT_REVIEW) review_on(c);
    if (!NIGHT_DRIVE) return;
    ev = live_ev(c);
    s->nd_ev = ev;
    if (ev == 0x7fffffff) { s->nd_cand = 0; return; }
    {
        u32 want = s->nd_dark;
        if (ev <= LIVE_EV_IN) want = 1; else if (ev >= LIVE_EV_OUT) want = 0;
        if (want == s->nd_dark) s->nd_cand = 0;
        else if (s->nd_cand != want + 1) { s->nd_cand = want + 1; s->nd_tick = now; }
        else if (us(c, s, s->nd_tick, now) >= DWELL_US) { s->nd_dark = want; s->nd_cand = 0; }
    }
    fl = rd8(c->user, NB_FLAGS); drv = rd8(k, CUR_DRIVE);
    if ((fl & NBF_DRV) && drv != DRIVE_CONTINUOUS) { nb_flags(c, fl & ~NBF_DRV); return; }   /* the user changed it: theirs */
    if (fe_plans(s) & 0x3f) return;                                /* the front end is busy (a shot, a half-press plan) */
    if (ram((const u8 *)s->lv_obj) && !rd8((const u8 *)s->lv_obj, LV_RUNNING)) return;
    if (s->nd_dark && !(fl & NBF_DRV) && drv == 0 && rd8(k, CUR_TIMER) == 0) {
        nb_flags(c, fl | NBF_DRV);
        c->set_drive(cur(c), DRIVE_CONTINUOUS);
        if (rd8(k, CUR_DRIVE) != DRIVE_CONTINUOUS) nb_flags(c, fl & ~NBF_DRV); else s->nd_switches++;
    } else if (!s->nd_dark && (fl & NBF_DRV) && drv == DRIVE_CONTINUOUS) {
        c->set_drive(cur(c), 0);
        nb_flags(c, fl & ~NBF_DRV);
        s->nd_switches += 0x10000;
    }
}

#include "c/mf_core.c"
/* night_tone.c has two static helpers of the same names as mf_core.c's (different types): renamed for this unit only */
#define udiv64 nt_udiv64
#define clampi nt_clampi
#include "c/night_tone.c"
#undef udiv64
#undef clampi
typedef char strip_rows_check[(STRIP_ROWS == MF_STRIP_ROWS) ? 1 : -1];
/* the offsets the appended code (handnight.ts) uses */
typedef char state_offsets_check[(__builtin_offsetof(struct state, busy) == 4 && __builtin_offsetof(struct state, progress) == 0xc &&
                                  __builtin_offsetof(struct state, ui_core) == 0x24 && __builtin_offsetof(struct state, lv_armed) == 0x28 &&
                                  __builtin_offsetof(struct state, lv_deferred) == 0x2c && __builtin_offsetof(struct state, lv_obj) == 0x30 &&
                                  __builtin_offsetof(struct state, lv_skips) == 0x34 && __builtin_offsetof(struct state, lv_seq) == 0x38 &&
                                  __builtin_offsetof(struct state, lv_arm_tick) == 0x3c && __builtin_offsetof(struct state, lv_ui_net) == 0x40 &&
                                  __builtin_offsetof(struct state, lv_ui_ret) == 0x44 && __builtin_offsetof(struct state, active) == 0x48 &&
                                  __builtin_offsetof(struct state, ui_frame) == 0x4c && __builtin_offsetof(struct state, ui_calls) == 0x50 &&
                                  __builtin_offsetof(struct state, ui_sample_tick) == 0x54 && __builtin_offsetof(struct state, ui_nsamples) == 0x58 &&
                                  __builtin_offsetof(struct state, ui_samples) == 0x5c && __builtin_offsetof(struct state, hold) == 0xc0 &&
                                  sizeof(struct hslot) == 16 && __builtin_offsetof(struct state, app_req) == 0xf0 &&
                                  __builtin_offsetof(struct state, lv_watch) == 0xfc && __builtin_offsetof(struct state, lv_start_ret) == 0x100 &&
                                  __builtin_offsetof(struct state, post_on) == 0x108 && __builtin_offsetof(struct state, post_n) == 0x114 &&
                                  __builtin_offsetof(struct state, post) == 0x118 && __builtin_offsetof(struct state, lv_post_tick) == 0x208 &&
                                  __builtin_offsetof(struct state, fb_ret) == 0x20c && __builtin_offsetof(struct state, fb_tick) == 0x210 &&
                                  __builtin_offsetof(struct state, ui_hold) == 0x214 && __builtin_offsetof(struct state, ev_n) == 0x218 &&
                                  __builtin_offsetof(struct state, ev_crm) == 0x220 && __builtin_offsetof(struct state, ev_ctrl) == 0x224 &&
                                  __builtin_offsetof(struct state, pb_n) == 0x228 && __builtin_offsetof(struct state, ev_ring) == 0x22c &&
                                  __builtin_offsetof(struct state, pb_ring) == 0x22c + 4 * EV_RING_N * EV_WORDS &&
                                  __builtin_offsetof(struct state, osd_full) == 0x122c && __builtin_offsetof(struct state, dv) == 0x1230 &&
                                  sizeof(struct dv_watch) == 4 * 231 && __builtin_offsetof(struct state, dv_req) == 0x1968 &&
                                  __builtin_offsetof(struct state, dv_posted) == 0x198c && __builtin_offsetof(struct state, ev_keys) == 0xbc) ? 1 : -1];  /* (test_osd.py uses these) */
typedef char ctx_sink_check[(__builtin_offsetof(struct ctx, log_sink) == 0xc8) ? 1 : -1];   /* (sim.py: the emulator's record sink) */
