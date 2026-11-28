<!-- SPDX-License-Identifier: GPL-2.0-only -->
# Handheld Night (GR IV 1.20; 1.21 is the generated copy tools/gr4v121/handnight)

The option `handheldNight` (`core/src/fw/gr4v121/aspect/handnight.ts`) adds a line "Handheld Night" to the still menu (off by default).
With it on, in the dark one press of the shutter takes 4 frames; the camera aligns them and merges them (HDR+ style) on three cores
and keeps only the merged photo (DNG and JPEG). How it is hooked into the camera: the header of `handnight.ts` and of `mfmod.c`.

| file | what |
|---|---|
| `mfmod.c` | the camera module: grouping the frames of a burst, holding frames 1-3 in place, memory, the time limit, the settings the switch manages, the processing screen's state, the merged frame's development and review end |
| `c/mf_core.c`, `c/mf_core.h` | the merge (alignment on a pyramid, per-pixel weights, the 8 x 8 block check, the weighted mean), integer only, NEON kernels |
| `c/night_tone.c`, `c/night_tone.h` | the brightening of the merged frame (at most 0.5 stop; its target rule is libcamera's AGC rule, re-implemented, see the file's header) |
| `ref.py`, `night_tone_ref.py` | the bit-exact integer specifications of the two C parts |
| `gen.py` | compiles `mfmod.c` for the camera -> `core/src/fw/gr4v121/aspect/handnight-code.ts` (position independent, no data sections, no library calls) |
| `build.ts` | an engine build of an official file for the checks: `fwdc248b.bin`, `patched-RTOS.bin`, `res.bin` (the camera's fonts), `manifest.json` (the layout) |
| `sim.py` | the emulator harness (unicorn; the camera's own code on the paths the hooks touch, the module's worker tasks taking turns on one emulated CPU; what Python replaces is listed in its docstring) |
| `test_groups.py` | 4 presses in the camera's module order (merged, merged, not merged, merged): every frame's data, the "no file" byte, the posts, the frees; the UI task's per-loop call through the merge, its end and the window after it (a key, a release, the power key, another screen, a shot); frame 1 stored before the result (KEEP_FIRST) in every ending, at least one picture of each press kept |
| `test_screen.py` | the two live-view hooks (LiveViewController +0x2C; the layer render's `bl` GroupView Draw, where the live view's root is drawn) against the official image, the camera's own per-loop path (update, then the controller's frame and layer render), a child view that redraws itself kept under the processing screen and drawn again after it, the processing screen drawn by the camera's own fill / bitmap / text code, the texts in every language and their glyphs |
| `test_fe.py`, `test_tap.py` | the front end: 4 frames per press (held, tapped, aborted, a second press), the ISO / EV gate |
| `test_hold.py` | frames 1-3 held: the stock release step, RAW codec completion, the next shot's allocation and the relocation run for real on held recipes |
| `test_keep.py` | only the merged frame stored (the stock store configuration and store handler, run for real) |
| `test_review.py`, `test_ae.py`, `test_ui.py` | the review after a shot, the 1/30 s shutter limit (every AE mode), the menu line and the settings the switch manages (the camera's own setters) |
| `read_mf.py` | reads the module's group record (handed to the emulator only: the camera build writes no file) |

    python3 -I tools/gr4v121/handnight/gen.py
    node node_modules/vite-node/vite-node.mjs tools/gr4v121/handnight/build.ts OFFICIAL_120.bin OUT          # [OPTIONS_JSON [off]]
    # outside the sandbox (unicorn); OFFICIAL_RTOS: the official RTOS section, OUT from build.ts
    python3 -I tools/gr4v121/handnight/test_groups.py OUT/patched-RTOS.bin
    python3 -I tools/gr4v121/handnight/test_screen.py OFFICIAL_RTOS OUT
    python3 -I tools/gr4v121/handnight/test_fe.py OFFICIAL_RTOS OUT/patched-RTOS.bin
    python3 -I tools/gr4v121/handnight/test_tap.py OFFICIAL_RTOS OUT/patched-RTOS.bin OUT/manifest.json
    python3 -I tools/gr4v121/handnight/test_hold.py OFFICIAL_RTOS OUT/patched-RTOS.bin OUT/manifest.json
    python3 -I tools/gr4v121/handnight/test_keep.py OFFICIAL_RTOS OUT/patched-RTOS.bin OUT/manifest.json
    python3 -I tools/gr4v121/handnight/test_review.py OFFICIAL_RTOS OUT/patched-RTOS.bin
    python3 -I tools/gr4v121/handnight/test_ae.py OFFICIAL_RTOS OUT/patched-RTOS.bin
    python3 -I tools/gr4v121/handnight/test_ui.py OUT/patched-RTOS.bin OUT/manifest.json

The module's switches (`#ifndef` in `mfmod.c`, `gen.py -DNAME=V` for a variant) are those of the build used on the camera: PROBES 0
(no record file, no recording hook), KEEP_LAST_ONLY 1, KEEP_FIRST 1, PROGRESS_BAR 1, PROC_TEXT 1. `gen.py -DPROBES=1` makes a recording build for camera
tests only (log files C:\MFxxxxxx.BIN / C:\MPxxxxxx.BIN, read by `read_mf.py`; log version 23 adds, every 0.5 s of the merge, the live
view's root renders, the processing-screen draws and the root invalidations): it behaves as the build above except the records
(`test_groups.py PROBES0_RTOS --against PROBES1_RTOS`). The labels mf13 .. mf25 in the comments are the
research builds the behaviour was developed and tested on, on the camera, one after the other; T7x are the sections of the research
notes those builds were documented in. The C parts were checked bit for bit against `ref.py` / `night_tone_ref.py` in the
research line (synthetic frames and public HDR+ bursts, on the computer and the ARM builds under unicorn); those check scripts are
not part of this directory.
