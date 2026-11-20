# tools/gr4v120/awb2: a learned auto white balance (GR IV 1.20 and 1.21)

The module that the `awbLearn` option installs (`core/src/fw/gr4v120/aspect/awb2.ts`). It replaces the camera's estimate of the
light in the three Auto white balance modes (Auto, Warmth Priority, White Priority) by a learned illuminant model, computed in
integers on the camera, in live view and for the picture.

## Behaviour
- **One estimator, one state, three modes.** Live view filters the single-frame estimates (a Kalman filter per axis that restarts
  on a confirmed scene change). **A capture takes the live view state**, so the picture has the white balance the screen showed.
  A capture uses its own estimate only when it is far from the live view state (more than 0.4 log2 in warmth or tint: another
  scene) or when there is no state.
- The modes share the estimate and differ only in how much of a warm light's colour is left (residual log2 R/B of a neutral):
  White Priority 0, Auto +0.10, Warmth Priority +0.35 at about 2850 K and warmer, fading linearly to 0 at about 5000 K
  (`golden.RETAIN`, `X_ZERO`, `X_FULL`). Outdoors the three are identical and neutral.
- **A picture taken with the flash keeps the camera's own result.** The exposure says "dim, lamp light" while the subject is lit by
  the flash; the camera's estimate is the better one there. The module reads the body's own decision: the flash data manager's
  type (0 = no flash) and the shooting sequence controller's "still waiting for the charge" byte, which the release sequence sets
  before the exposure (0 = the main flash fires). Live view is not affected.
- Preset, manual and Multi modes (S+0x34 > 2): the module writes nothing, the camera's result stays.
- The hook runs after the camera's own final stage (0x53960e90 calls 0x539609d4 inside the Auto estimate 0x53960b8c): where the
  module writes nothing, the camera's result is already there.

## The model
Two 64 x 64 log-chroma histograms on a torus (pixel colours and local colour contrast), two learned filters applied in the
frequency domain, a brightness-dependent prior `B0 + e B1 + tanh(2e) B2` (e = (EV - 4) / 4; `B3` alone when the brightness is not
known), softmax, circular mean: the FFCC family (Barron and Tsai, "Fast Fourier Color Constancy", CVPR 2017). Parameters:
`model/illum_v2.npz` (filters `F[2]`, priors `B[4]`, 64 x 64 each; nothing else). How it was trained: `train/README.md`.

Integer implementation: one complex FFT for both real histograms (h1 + i h2, separated by symmetry), fixed-point tables
(`tables.py`, `awb2_const.h`), no floating point, no library call, no data section. Live view spreads one computation over two
consecutive calls and computes on one call in four (`AWB2_PERIOD`).

## Accuracy (held-out scenes with measured illuminants)
462 scenes of SimpleCube++ that the model was not trained on, converted to GR IV statistics space with the GR IV DNG colour
matrices. The camera's own estimators on the same scenes are a bit-exact transcription of the official 1.20 code.
Angular error of the estimated light:

| estimator | mean | median | worst 25 % |
|---|---|---|---|
| camera, Auto | 4.43 deg | 3.51 deg | 8.59 deg |
| camera, White Priority | 4.02 deg | 3.31 deg | 7.93 deg |
| this module | 1.56 deg | 0.60 deg | 4.69 deg |

Residual warmth of a neutral after white balance (log2 R/B, + = too warm, 0.1 is about where a difference starts to show):
median, and the share of scenes within +-0.15 (11 extreme orange lights, sodium-like, excluded):

| light | n | camera Auto | camera White Priority | this module, Auto | this module, White Priority |
|---|---|---|---|---|---|
| shade / cloudy | 39 | -0.69, 0 % | -0.69, 0 % | -0.01, 69 % | -0.01, 69 % |
| daylight | 266 | -0.27, 5 % | -0.27, 5 % | +0.01, 95 % | +0.01, 95 % |
| warm daylight | 84 | -0.17, 39 % | -0.17, 38 % | +0.10, 76 % | +0.10, 76 % |
| 3500-4500 K | 31 | +0.28, 29 % | +0.02, 65 % | +0.06, 74 % | +0.01, 68 % |
| tungsten | 31 | +0.69, 0 % | +0.03, 65 % | +0.10, 68 % | +0.01, 97 % |

Over all 451 scenes, 86 % are within +-0.15 in Auto, against 12 % for the camera's Auto. In tungsten light Auto leaves +0.10 on
purpose (Warmth Priority +0.35); White Priority leaves nothing. Limits: only SimpleCube++ has the scene brightness, so the
with-brightness path is tested on one data set with few lamp-light scenes; mixed light has no single right answer for a global
white balance.

## Files
| file | what |
|---|---|
| `model.py` | float reference of the trained model |
| `golden.py` | float behaviour of the whole thing (estimate, retention, live view filter, capture rule) and its evaluation |
| `tables.py` | fixed-point tables and constants (writes `awb2_const.h`) |
| `awb2.c` | the camera module: integer only, position independent, no data sections, no library calls, no firmware address |
| `gen.py` | ARM build with those checks; writes `core/src/fw/gr4v120/aspect/awb2-code.ts` (module and tables) |
| `host.c`, `hostlib.py` | host build for the tests |
| `test_observe.py` | C estimate against the float model on the 462 held-out scenes |
| `test_entry.py` | whole entry against golden.py: live view sequences, captures, modes, flash, edge cases, a UBSan build |
| `test_fw.py` | the built firmware in unicorn against the host build, bit for bit |

## Run
```
export GRIV_DATA=...        # cubepp_gr/ (SimpleCube++ in GR IV statistics space), learnawb/cube_eval_preds.npz (its split and labels)
python3 gen.py              # git diff must stay empty unless awb2.c / tables.py / golden.py / the model changed
python3 test_observe.py && python3 test_entry.py
python3 test_fw.py <RTOS section of a build with awbLearn>
```
The data are not in the repository (`train/README.md`). The compiler cache and unicorn's JIT need to run outside a restrictive
sandbox.

## Results (this commit)
- `test_observe.py`: 462 held-out scenes, C against float: |du|, |dv| at most 0.00036 log units (0.0005 log2); variance ratio
  0.998 .. 1.001.
- `test_entry.py`: 77 sequences, 924 live view calls: worst gain error against the float reference 0.034 %; capture equal to the
  live view gains, bit for bit, 77 / 77; the three modes in order 77 / 77; preset mode and empty frame untouched; missing
  exposure, window offset and stride, a capture during a live view computation, live view block sizes, the flash rule; a UBSan
  build identical.
- `test_fw.py` on 1.20 and 1.21 builds, alone and with the other additions: 457 emulated calls, 0 differences from the host
  build; operator new once; the state pointer in 0x55839078; no write into the image; r4-r11 and sp preserved; 348 bytes of
  stack; per call about 2.7 M instructions on the two computing live view calls in four (3.3 M at most), 342 on the others, 5.0 M
  for a capture. The flash rule through the context's two addresses (type, waiting byte), against the host build.
- The module's bytes: 9540 (code) + 134656 (tables).

## On the camera (GR IV 1.20)
In daily use since 2026-11-11, in every build since: 11 camera rounds of test pictures from 2026-11-11 to 11-15 (163 pictures,
126 of them with DNG), and everyday shooting since.
- Without flash, the recorded gains equal the capture's estimate replayed from the DNG statistics (R 1.4 % lower, B 0.3 % higher,
  a constant). The 124 DNGs of 2026-11-11 .. 12 all have the still's block size the module expects (1584 pixels);
- flash: the rule above came from these rounds (flash-lit foregrounds in a lamp-lit room had come out blue with the module's
  estimate); since 2026-11-12 flash pictures keep the camera's result;
- live view: a fix of 2026-11-14 brought the pixel counts of live view's small blocks to the scale of a still's (before it, every
  live view block counted as "too few pixels", live view never had an estimate and the screen showed the camera's own white
  balance: yellower than the picture in lamp light, by about 0.5 log2 R/B). Since then the screen and the pictures look the same in
  use, at night as well; in rare night scenes a picture has come out slightly cooler than the screen (cause not established).

The first 64 bytes of the module's state (`struct awb2_diag` in `awb2.c`) describe the last live view computation and the last
capture, for debugging in an emulator or a build that copies them out; this option writes nothing to the card.

## Not covered
- 1.21 is checked in the emulator only (`test_fw.py` on the generated `tools/gr4v121/awb2`); the camera it has run on is a 1.20
  one. 1.11 is not offered.
- On the camera the state pointer was at another free word (0x5583901c, now the HDR gain map's): here it is in the sbrk arena
  before the heap, like the battery percentage's byte, cleared at start-up by the same zero fill.
