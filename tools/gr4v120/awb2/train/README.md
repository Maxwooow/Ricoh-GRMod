# tools/gr4v120/awb2/train: how the model was made

`../model/illum_v2.npz` holds the trained parameters and nothing else: the two filters `F` (2 x 64 x 64) and the four prior maps `B`
(4 x 64 x 64; with a known scene brightness `B0 + e B1 + tanh(2e) B2`, without one `B3`). `../tables.py` turns them into the fixed-point
tables that `../gen.py` embeds; `../model.py` is the float reference of the same model.

What it was trained on, in short:

- **Data**, all with a measured illuminant per scene and converted to GR IV statistics space with the GR IV DNG colour matrices
  (the camera's block statistics, as the AWB sees them): SimpleCube++ (2234 scenes, with exposure), Gehler-Shi (568, no exposure),
  INTEL-TAU 1080p (7022 scenes from three cameras, no exposure; CC BY-SA 4.0).
- **Loss**: angular error of the estimated light; lamp-light scenes weigh 3x; the exposure is dropped at random for 30 % of the
  scenes that have it, so the model also works without it; for daylight scenes an estimate warmer than the truth (a cool picture)
  costs twice as much. The smoothness weight was varied 0.03 .. 1 with one TAU camera left out of training entirely: no material
  difference, so the result does not hang on that setting.
- **Held out**: SimpleCube++'s test split, every third Gehler-Shi scene, every fourth run of 25 consecutive TAU frames. On a camera
  left out of training completely the model has 1.4 deg (Nikon) and 1.8 deg (Sony) median angular error on TAU field scenes.
  The SimpleCube++ figures are in `../README.md`.

No image, label or intermediate file is part of the repository, and the parameters contain none of them, only filter and prior
values. The training scripts are research code (they read local working copies of the data sets) and are not included here; the
module, its references and its tests do not depend on them.
