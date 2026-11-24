# Movie AF driven by the phase data (GR IV 1.20 / 1.21)

Build option `videoAf` (`core/src/fw/gr4v120/aspect/videoaf.ts`). Off unless asked for; 1.20 and 1.21 (1.21 through its
address table, checked in the emulator only); not offered on 1.11.

## What the camera does by itself while recording

Read in the code and seen in the module's records on the camera:

- **Contrast only.** The movie AF wobbles the lens around the focus (the wobbling module, travel state `0x5362f658`) and,
  when it loses the focus, runs a whole contrast search: it goes past the peak and comes back. The image goes soft and
  back ("breathing"), and with the picture changing the search often misses the peak and runs again.
- **The lens is held at 120 units/s.** While a movie is recorded lens property 0x5916 is set, and the lens control's
  relative move `0x53951b04` limits every move to the table at `0x54211d38` (120 units/s in all four entries) with motor
  setting 30 instead of 45 (`0x542120fc`). The camera's own moves in the records: 85 .. 107 units/s (median, per recording).
  Near hand to a background four or five metres away is 130 .. 420 lens units: 2 .. 6 s at that speed.
- **Each step is tiny.** The wobbling step is the aperture number x 0.012 x a lens unit (`0x53630620`), and its cap
  (`0x5362a8a0` .. `0x5362a8c4`) is max(speed / 100, basic step): with this lens speed / 100 is below the basic step, so
  the module's own acceleration (a multiple of the basic step) is always cut back to 1.
- **The phase data is there but not used.** The phase module runs in every focusing frame while recording, five areas
  round the middle (`0x5363c020`); its direction was right in 10 of 11 searches of a probe build. But whenever the
  standby monitor's scene flag is set, the camera empties the phase computation every frame (`0x536220d4` ->
  `0x5361171c`) and later asks for a whole new contrast search (`0x53614584`): in all 119 standby records with that flag
  (eight recordings of versions 5 and 6) the phase module was not running.

## What this adds

1. **Steps straight to the focus, from standby.** While the lens rests the module reads the phase result of every
   frame. When three reliable areas agree (reliability within the factory's own limit, 64), the lens is sent straight
   where the value says: a share of the value measured on the camera (near 0.19 x the first 100 + 0.24 x the rest; far
   0.31 x when the areas agree, else 0.24), at most twice the value before. The module takes the
   lens the way the movie AF does when a search begins (`0x5360d980`) and gives it back when it has stopped (`0x5360de18`):
   the lens takes a move only from whoever holds it.
2. **At the lens's ordinary speed.** The one move the module names is marked (bit 15 of the speed) and takes the
   ordinary branch of the lens control: 40 x amount units/s, at most 2500, motor setting 45. Every other move (the camera's
   own steps, the return to the peak, the long sweep of the hold state) stays at 120.
3. **No needless searches.** While the phase data is usable, the camera's own wish to search again from standby is
   refused (hook in its decision `0x53614584`), and a scene change no longer empties the phase computation while
   recording (`0x5362208c`, the still-shooting rule alone). One good area reading "in focus" is enough to refuse.
4. **The camera's search stays the way out where the phase data says nothing.** Without usable phase data the camera's
   own search is let through after 30 frames; a search let through that ends with still no data makes the next one wait
   120 frames more, doubling up to 600. Phase data saying "in focus" refuses for 180 frames at most, then one search is let
   through and judged by what the phase data reads where it ended.
5. **A search that does run is steered:** the travel vote (`0x5362f6fc`) takes the phase direction when it is strong
   and agrees, and one fast step is sent (0.28 x the value, value 150 and more, at most 200 units).
6. **Trust.** A step whose value did not fall as it should is a failure; two in a row, or three large steps landing with
   the value as large on the other side, and the module leaves the camera alone until its next search has ended. No step
   back the other way for 18 / 60 frames (large / small).
7. Two small changes of the camera's own movie AF, part of the same build on the camera: the wobbling cap is
   max(speed / 100, 16 x basic step) (with the module's flag + 0xd60 as before), and focus mode 8 (MovieRecording, no
   touch yet) uses the 64 x 52 single frame of mode 3 in the middle instead of the 590 x 380 auto area (which kept changing
   what it focused on). A touch while recording still moves the frame.

The rules were checked one by one against published ones (Canon, Olympus, Sony and Fujifilm patents; libcamera's
autofocus code): the hold before a reversal (Canon), the share of the way for less reliable areas (70 .. 80 %, Canon),
same-direction counts before acting (libcamera, Olympus), the limit on one step (libcamera's `max_slew`), the hand-over to
contrast when the direction keeps changing (Sony). What could not be taken over is this lens: it takes no new command
while it moves, and a phase result is 3 .. 7 frames behind the lens when it appears, so each step waits for a result
taken after the lens stopped (results count again 7 frames after it was seen to stop).

## On the camera (GR IV 1.20)

Module versions 4 to 13 were each built, checked in the emulator and used on the camera; each wrote a record of every
recording to the card (this PR's build does not, see below), and each next version was made from those records:

| version | recordings | what the records showed / what changed next |
|---|---|---|
| 4 | 2 | marked moves stored at 320 .. 2500 units/s, motor setting 45; a refocus of about 100 units in about 1.0 s instead of 1.7 s and more; all 8 replaced votes the right way. Clicked twice: a second fast step on a stale value |
| 5 | 3 (111 s) | no overshoot; 6 of 36 fast steps never sent (first step of a climb); the phase result is 4 .. 6 frames behind |
| 6 | 5 (165 s) | fast step 0.07 .. 0.21 s after a search begins (0.2 .. 0.85 s before); found the phase reset on scene changes |
| 7 | 1 | steps from standby not taken: nobody holds the lens in standby (found in the code, `untaken_quick.py`) |
| 8 | 2 | 153 of 153 standby steps moved the lens; value against distance measured, near and far |
| 9 | 2 | 178 of 178; far direction measured (0.31 .. 0.43 lens units a value unit) |
| 10 | 1 | 109 of 109, trust never lost; 2 searches let through on the way back (no data with three areas) |
| 11 | 1 | 147 steps in 43 s of standby, no camera search; once trust lost wrongly (subject moving away) |
| 12 | 3 | a room with a floor lamp: all five areas invalid most of the time; the factory's own reliability limit 64 adopted |
| **13 (this PR)** | **17 (195 s, at night)** | **see below** |

Version 13, 17 recordings at an outdoor light show at night (the module's records, `read_quick.py`):

- 255 steps sent straight from standby; none left the lens standing.
- In 13 of the 17 recordings the only search is the one the camera makes when recording starts (0.5 .. 1.8 s); the phase
  data kept the focus for the rest. The other 4 had 6 searches, 15.7 s in all: 3 (11.0 s) in a 57 s recording of a
  zip line, let through when the phase data dropped out for about 0.5 s while the focus was right (they came back where
  they began, within 1 .. 12 units); one of 2.2 s was a real change of subject (259 units, a fast step 0.26 s in).
- The camera wanted to search again and was refused 548 times while the phase data said "in focus".
- Measured lens speed of the module's steps up to 2071 units/s; the camera's own moves 85 .. 107 units/s.
- Known: at night the phase values are noisier (about twice the indoor spread) and drop out for 0.4 .. 1.5 s now and then;
  in the zip-line recording that gave the three searches above and, in its last 34 s, 56 small steps back and forth (5 ..
  37 units), which may show as a slight breathing.

Since then (the same version number: the record is unchanged): a recording in which the phase result never changes after
its first frames has no phase data at all, and the camera's own search is let through as if the module were not there
(`STALL_TICKS`, `STALL_RESULT`). That is a 4K movie (`core/src/fw/gr4v120/aspect/movie4k.ts`): on a GR IV 1.21 the focus stood
still for a whole 4K recording with every search refused (test firmware 094), and follows as the official firmware's does with
this rule (test firmware 097, where a stub in front of the module did the same).

## Tests on the computer

- `test_quick.py OFFICIAL_RTOS PATCHED_RTOS` (180 checks): the stubs as built, and the camera's own code wherever the
  hooks touch it, run in unicorn (`cam.py`): the wobbling module's travel state `0x5362f658` and lens move `0x536304bc`, the
  lens interface `0x5360d9a8` -> `0x5395110c`, the lens control's dispatcher `0x53952f14` and relative move `0x53951b04`,
  the standby monitor and the camera's own decision `0x53614584` with its request `0x53609bb0`. Official against patched:
  only a move the module names is faster; every other move as before. The build has no file service; the test puts the
  camera's back in a copy of the image to read the record, and checks that the build itself opens no file.
- `sim_quick.py OFFICIAL_RTOS PATCHED_RTOS`: closed loop round the travel state (the camera's code, a model lens, phase
  and contrast), 240 cases of distance, phase scale, lag and period, camera alone against this build: never slower, no
  swinging, at most one fast move; in focus sooner by 0.85 s (median; 170 units: 1.80 s -> 0.57 s median, 280 units:
  2.81 s -> 0.95 s). Slower only where the phase direction is made wrong on purpose (170 units: 1.6 s -> 3.3 s).
- `sim_follow.py PATCHED_RTOS`: closed loop of the standby path (monitor stub -> module -> the wobbling module's real lens
  move -> the real lens interface, the lens held by nobody in standby): no case swings, creeps away, passes the focus by
  more than 12 units, lets a search through while the phase data is usable, or fails to end within 8 units.
- `sweep_quick.py PATCHED_RTOS`: 2560 travel frames over the camera's sub-states; no crash, every fast move the one named.
- `untaken_quick.py PATCHED_RTOS`: a standby step with the lens held by nobody, by the movie AF, by someone else.
- `test_inplace.py OFFICIAL_RTOS PATCHED_RTOS`: the step cap (98 cases) and the focus area by mode (16 modes), the
  camera's code on both images.
- The module bytes (`gen.py`, 15580 bytes) are the ones of the build the 17 recordings were made with, and `sim_quick.py`,
  `sim_follow.py` and `sweep_quick.py` print the same, line for line, for this PR's build and for that one.

## What this build does not do

- The module can write a record of each recording to the card (`C:\VQxxxxxx.BIN`, `read_quick.py` reads it); this build
  gives it no file service (the `file_holder` native is a stub returning 0), so nothing is written. The record stays in RAM.
- No change where the phase data says nothing: no reliable area means the camera's own search, as without the option.
- Not on 1.11.
