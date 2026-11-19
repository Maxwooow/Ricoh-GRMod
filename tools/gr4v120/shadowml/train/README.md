# tools/gr4v120/shadowml/train: how the model was made

`../model/model_final.bin` (5544 bytes, SHA-256 in `../model/model_final.sha256`) is the trained model that
`../gen.py` embeds as `core/src/fw/gr4v120/aspect/shadowml-data.ts`. It is data only: 100 gradient-boosted regression
trees in the blob format documented in `../ref.py`. A new model needs no new code: `gen.py other-model.bin`.

What it was trained on, in short:

- **Labels**: MIT-Adobe FiveK (975 images used): for each image, how much the five professional retouchers
  (median of the five) lifted the shadows, measured as the camera's own shadow-correction strength `t`
  (0 .. 0x800, searched on a grid) whose simulated rendering comes closest to the retouched version, also at
  exposure offsets of -0.5 .. +0.5 stop around the simulated AE and at several ISO / highlight settings.
- **Features**: what the module can see in the camera: the block statistics of the AWB (the green plane as
  block luminance), as relative brightness only: log2 percentiles, the share of blocks 1..5 stops below the
  median, near-clipped blocks, centre against border, the ISO index, the mode (still / live view / movie),
  the R/G and B/G cast. The FiveK RAW files were developed into those block statistics the way the GR IV
  computes them.
- **Model selection**: held-out images, scored by the regret against the retouchers' median: 0.0256, against
  0.0310 for no lift and 0.0334 for the camera's own Auto rule computed on data that does not wrap.

No image, label or intermediate file is part of the repository, and the model contains none of them, only
tree thresholds and leaf values. The training scripts are research code (they read a local working
directory of FiveK and GR IV DNG files) and are not included here; the module, its reference and its tests
(`../ref.py`, `../test_host.py`, `../test_arm.py`, `../test_fw.py`) do not depend on them.
