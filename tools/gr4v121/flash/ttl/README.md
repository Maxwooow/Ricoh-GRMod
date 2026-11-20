# Flash TTL (GR IV 1.21 copy of the 1.20 tools, GF-2 class flash)

Build option `flashTtl` (`core/src/fw/gr4v120/aspect/flttl.ts`). Off unless asked for; GR IV 1.20 and 1.21. On 1.21 the same module runs
through the address table; the camera rounds below were all on 1.20.

## What the camera does by itself

With a GF-2 class flash in the automatic output mode the body sets the flash's output from the focus distance
(`0x536a59f8`, auto branch; `0x5369d7f8` returns X):

    X  = Dv + Av - (Sv - 5) + compensation,   Dv = 2 log2(focus distance in m)   (record + 0x84)
    A0 = 8 X + 52, limited to the flash's range (4 .. 77, 77 = full, 1/8 EV a step)

So a subject nearer or farther than the focus point, or a wrong / missing focus distance (the body then plans for 30 m),
gets the wrong amount of light. In the two flash modes with red-eye reduction the body also fires one small emission
(level 0x40) before the picture (state 0xA in the flash data, `0x536a5f50`). Ricoh's own pre-flash conversion code is
in the firmware but the command that starts it (0x61C40807) is never sent in 1.20.

## What this adds

Only when that red-eye pre-emission fires (the other two flash modes and the manual output are not touched):

1. The live view frame that catches the pre-emission is compared with the frame before it (raw block statistics, green
   sums less black). Rows the emission did not reach are left out (the sensor reads rows one after another, a short
   exposure catches the emission in a band); of the blocks in the lit rows the quarter that gained most counts: the
   nearest thing in the frame, which is what a flash must not burn out.

       r   = (flash-lit part, pre-emission minus before) / (whole frame before)
       Dv' = (P - 52) / 8 + Tv_lv - Ev - log2 r

   P is the pre-emission's level, Tv_lv = log2(1 s / live view exposure time), Ev the scene brightness of the camera's
   own live view AE (record + 0x140). Dv' replaces Dv in the camera's formula, so the picture's aperture, ISO, flash
   compensation and ND keep working through it. There is no calibration constant of this module's own.
2. Limits: at most 6 EV less and 2 EV more than the camera; no lower limit where the camera has no usable distance
   (10 m or more, or none). More than a quarter of the counted blocks clipped: 1 EV less.
3. Not used (the camera's own output stays) when the comparison is not in order: no pre-emission seen (the lit rows
   gained less than 1/8 of the scene, or are less than 1/8 of the frame), live view exposure time different between the
   two frames or gain different by more than a quarter, live view exposure out of 2 .. 200 ms, scene Ev out of
   -3 .. 18, a sum of zero, result older than 1.2 s.
4. When the frame before the pulse is older than 100 ms or was exposed differently, the second frame after the one with
   the pre-emission is used instead (the emission can span two frames; the second one after has none of it).
5. The pre-emission is made weaker for near subjects so that the live view frame does not clip: the camera's own formula
   for the focus distance at the live view's sensitivity, half an EV less, 20 .. 0x40 (unknown distance: as for 2 m).
6. For this to work the release plan's "free live view" step starts 150 ms later in the two red-eye modes (so the frame
   with the pre-emission still arrives), and the flash's "not ready" while it recharges after the pre-emission is not
   stored for 600 ms (or the camera cancels the picture's flash).

The module keeps one allocation of about 34 KB (two frames of block values) from the first live view frame with a GF-2
class flash attached. It can write a 644-byte record of each shot (struct log in `flttl.c`) to the card; GR Mod builds
give it no file service, so nothing is written.

## Camera rounds

Four rounds on a GR IV 1.20 with a GF-2, red-eye flash modes, indoors, from evening to daylight (each round changed the
module after it):

| Round | Version | Shots | Measurement used | Notes |
|---|---|---|---|---|
| 1 | 1 | 21 | 8 | Clip threshold too low (half scale), small gain trims rejected; changed in version 2 |
| 2 | 2 | 14 | 10 | 2 of the 10 took noise for the pre-emission (+0.6, +0.9 EV); stricter "seen" test in version 3 |
| 3 | 3 | 17 | 17 | One shot with no focus distance (body planned for 30 m) still 6 EV too bright: the 4 EV limit; version 4 drops it there |
| 4 | 4 | 22 | 12 | 6 not used because the frame before the pulse was 0.3 .. 1.2 s old; version 5 compares with a frame after instead |

- Where the subject was at the focus distance with nothing nearer, the measured distance agreed with the body's focus
  distance within 0.25 EV (round 3: +0.23, +0.07, -0.06 EV); that is the two methods agreeing, not an independent
  calibration.
- Pre-emission levels down to 18 were fired and measured correctly (round 3).
- In about 1 shot in 10 (8 of 74 in the four rounds) no live view frame within 140 ms caught the pre-emission, although
  the flash reported recharging after it. Why is not known. Those shots get the camera's own output, as without this
  option.
- Version 5 (this one) has been in the firmware of daily use since then, but has not had a dedicated test round: the
  comparison with the frame after the pulse and the minimum pre-emission level of 20 are checked on the computer only.
  Its premise, that the main flash's X is asked for after that later frame (55 .. 125 ms after the pulse), is not
  verified; if X is asked for earlier, the shot gets the camera's output, as before.
- Not done: the ISO and shutter the body chose before the pre-emission are not changed (with no focus distance the body
  still picks a high ISO; the flash amount is then right but the picture noisier).

## Files

- `flttl.c`: the module (soft float, position independent, no data sections, no library calls), entry
  `flttl(ctx, which, a, b)`.
- `gen.py`: compiles it with zig and writes `core/src/fw/gr4v120/aspect/flttl-code.ts` (checks position independence,
  no undefined symbols, the record's size).
- `host_test.c`: the module on the computer against a plain floating-point version, five scenes (centre lit; only a band
  of rows lit; centre clipped; no return; subject much nearer than the focus point), 16 x 16 and 64 x 64 grids, the
  rejection cases and the frame-after case.
- `test_arm.py` (with `armlite.py`): a built RTOS with the option, the six stubs entered as the camera enters them and the
  appended module run instruction by instruction; the five shots must give the host build's X, levels and records.
- `evidence.py`: re-checks the firmware facts above against the official 1.20 RTOS.

## Checks

    PY=python3   # with capstone, numpy, ziglang
    $PY tools/gr4v121/flash/ttl/gen.py                                      # module 7140 bytes
    cc -O1 -DFLTTL_HOST -o host_test tools/gr4v121/flash/ttl/host_test.c -lm && ./host_test HOST_LOGS.bin
    $PY tools/gr4v121/flash/ttl/test_arm.py BUILT_RTOS.bin HOST_LOGS.bin    # RTOS section of a build with flashTtl
    GRIV_RTOS=OFFICIAL_120_RTOS.bin $PY tools/gr4v121/flash/ttl/evidence.py
    npx vitest run test/flashttl.test.ts                                    # in core/: install, build, read back

## Tuning

- Overall brighter / darker: `BIAS_Q8` (1/256 EV, positive = more flash).
- Limits: `LOWER_Q8`, `RAISE_Q8`.
- Pre-emission: `PRE_HEADROOM` (1/8 EV steps, larger = weaker), `PRE_MIN`.
- Clip threshold: `FULL`.
