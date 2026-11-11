# GR III 2.20: Minimum Shutter Speed down to 30 s (issue #25, test 1)

Test firmware only (official 2.20 + this change), not in the app yet.

The camera's list (SvAutoLowerTvSetController, ISO Setting › Minimum Shutter Speed) has 31 values,
1/1000 .. 1 s, from a (numerator, denominator) table at 0x53B41B38: the camera's third-stop shutter
table at 0x53D62CB8 (30 s .. 1/25600) read backwards from index 45 to 15. The test reads that table
backwards down to index 0: 46 values, then 1.3 s .. 30 s. 15 instructions change (table address,
count, direction, the held-Down stop) and the list's create function (0x531CFA20) is rewritten with a
larger stack buffer for the row types; 48 words between 0x531CF824 and 0x531CFC1C.

    python3 dump_sites.py rtos.bin sites.json                       # official 2.20 RTOS -> words to change
    npx tsx build.mts fwdc239b.bin sites.json out/fwdc239b.bin MINSS30   # (from core/) the container
    python3 verify_out.py                                          # emulator checks, official vs built

`emu.py` runs the camera's own list functions (create, rows, set, mark current, keys) with the list
widget and property services substituted and compares the official and the patched image. What the
exposure program does with a limit slower than 1 s is only known from the camera.
GR IIIx 1.70 is the same program (same addresses).
