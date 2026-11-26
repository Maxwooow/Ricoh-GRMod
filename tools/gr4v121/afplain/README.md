# Subject recognition for photo AF (GR IV 1.20 / 1.21)

Build option `subjectAf` (`core/src/fw/gr4v120/aspect/subjectaf.ts`). Off unless asked for; 1.20 and 1.21 (1.21 through its
address table, checked in the emulator only); not offered on 1.11.

This is the 1.21 copy of `tools/gr4v120/afplain` (`tools/port/gr4-121.json`): the addresses below are 1.21's. `gen.py` compiles
this copy's runtime (its addresses mapped) into `core/src/fw/gr4v121/aspect/subjectaf-code.ts`; the model is shared with
1.20 (`core/src/fw/gr4v120/aspect/subjectaf-model-code.ts`, so `gen_model.py` is not run here). The camera rounds were all
made on 1.20.

At half-press a small integer convolutional network looks at a 96 x 64 thumbnail of the live view and decides where the
subject is; the AF area is put there. Focusing itself is the camera's own AF (lens drive, speed and precision unchanged).

## What it does

| when (task) | what | hook |
|---|---|---|
| every live-view frame (LV task) | 8 frames after the last thumbnail, a new 96 x 64 thumbnail (each pixel the mean of 2 x 2 samples), three buffers in turn | `0x5365d4e8` |
| half-press, before the camera sends AF START (UI task) | the network on the newest thumbnail; the box turned into the camera's 60-byte face / eye area and published | `0x533ad5b4` |
| the AF task reads "the selected face" | the camera's answer first; when it is empty and a fresh box is there, the box | `0x5360f510` |
| the end of an AF pass (AF task) | later area / rectangle reads get the camera's answer again | `0x53626d50` |
| the in-focus sound (UI task) | when this focus used the box: the camera's short shutter sound | `0x533b0ebc` |
| JPEG / DNG written | a 96-byte record (private maker note tag 0xc7a3) and a 10 x 8 luminance thumbnail (0xc7a2) | `0x53831f0c` / `0x5382a8bc` |
| the maker note serializer's data setter | for these two tags only: the camera's setter is skipped (it writes their payload as zeros otherwise) | vtable slot `0x53fdf6bc` |

Rules, in this order:

1. Movies, focus modes other than Auto Area (and Follow / Continuous, below), a temporary focus mode, a manual point: the
   camera's own (no box at half-press).
2. When the camera's "selected face" is not empty: the camera's own (its face / eye answer is always taken first).
3. Else the box. When the network has no answer (blank frame, thumbnail older than 90 frames, model error) the box is the
   centre 2 x 2 cells. Only before the first thumbnail since power-on, or when the state allocation failed, does the camera's
   own multi-point choice decide.

Follow (focus mode 5) and Continuous (6): at half-press the network picks a cell and the start frame (64 x 52) is moved
there through the camera's own frame move (`runtime/stock_point_api.h`: clamp `0x533aeae4`, frame size `0x533ae8fc`,
geometry `0x533b0290`, Common area `0x5377f448`, the focus model's point `0x533aec04` and notice `0x533aee88`); the camera
tracks from there. No answer (no thumbnail, too old, blank) or not the full 3:2 frame: the frame stays where it was.
In Follow the camera's face detection is kept on: in the settings recompute (`0x532ae468`) "Common AF kind == 1" keeps the
face setting On; three words at `0x532ae470` make it "kind is odd" (1 single, 3 tracking). A face found by the camera starts
the frame on the larger valid eye, else on the face; without a face, the network. Continuous AF (kind 2) is unchanged.

The network: 96 x 64 input, 12 x 8 scores, 5.4 M multiply-adds, 63960 bytes of integer weights (`subjectaf-model-code.ts`,
SHA-256 `8d3291b4...`), pure integer (no float, no division, no globals), the 1 x 1 convolutions with SMLAD. Priority: human
heads and cat / dog heads, then the bodies of people and animals, then the most salient object. Trained off the camera on
public data sets (DUTS-TR, COCO train2017, Oxford-IIIT Pet), rendered as the live view would see them. The box given to the
camera is 1.5 x 1.5 cells round the peak.

## Memory

- The module, the model, the 80-byte context, a two-word trampoline for the getter and the eight adapters are appended last
  (after every other addition). Each adapter keeps r0-r12, lr, the flags, FPSCR and d0-d31 and calls
  `af_s1_dispatch(op, frame, 0, ctx)`.
- Counters (struct pl_static, 276 bytes) at `0x55839080`, in 512 bytes before the heap: the heap's first block starts
  512 bytes later (`0x53ad4c4c`, `movw r3, #0x9080` -> `#0x9280`) and the start-up zero fill (`0x53000460`) reaches
  `0x55839280`. The C library's sbrk arena `0x55839040..0x55839080`, where other additions keep their words (`battery.ts`),
  is not touched.
- The working state (153 KB: three thumbnails, the network's scratch) is one allocation of the camera's heap 2 at the first
  live-view frame; when it fails, flags bit 64 in the record and everything is the camera's own.

## Camera rounds

The runtime has run on a GR IV 1.20 since November 2026 in these switches (record flags 1 | 2 | 4 | 8: on, sound cue, start
frame in Follow / Continuous, faces kept in Follow), with the same model. Rounds and what changed after them: the thumbnail
age limit 900 -> 90 frames (old thumbnails showed another scene); between half-presses the live view hands over "direct"
recipes without a descriptor, and the thumbnail is now taken from that canvas too (`stock_tier_lv.h`), so the half-press
finds a fresh thumbnail; waiting for a frame after the half-press did not work (the frames follow the AF start) and was
removed. In the last round (17 half-presses indoors at night) every half-press had a fresh thumbnail and a box; the network
takes about 75 ms (about 33.6 M cycles at 450 MHz) before the camera's AF starts.

The module bytes are those of the camera build except the state address: 25 `movw` immediates `0x9040 + n` -> `0x9080 + n`
(the counters moved from `0x55839040` to `0x55839080`, after the arena the other additions now use).

## Build and checks

```sh
python3 tools/gr4v121/afplain/gen.py              # runtime/ -> core/src/fw/gr4v121/aspect/subjectaf-code.ts
python3 tools/gr4v121/afplain/gen_model.py MODEL  # the trained model -> subjectaf-model-code.ts (1.20 only; 1.21 shares it)
node node_modules/vite-node/vite-node.mjs tools/gr4v121/afplain/build.ts OFFICIAL.bin OUT/v120-02 ['{"ratios":[...],...}']
python3 tools/gr4v121/afplain/evaluation/make_fixture.py FIXTURES
AF_FIXTURES=FIXTURES python3 tools/gr4v121/afplain/evaluation/test_plain_units.py --artifact OUT/v120-02 --repo . --output units.json
python3 -I tools/gr4v121/afplain/evaluation/native_plain_probe.py --artifacts OUT --work OUT --fixture-dir FIXTURES --repo . \
  --output probe.json --expected v120-02=SHA256_OF_OUT/v120-02/fwdc248b.bin --version v120-02 --case CASE [--geometry-matrix]
python3 tools/gr4v121/afplain/evaluation/face_follow_rule_probe.py --rtos OFFICIAL_RTOS --fixture-dir tools/gr4v121/afplain/evaluation \
  --repo . --output face.json --patched OUT/v120-02/patched-RTOS.bin
```

- `test_plain_units.py` (12 cases): drives `af_s1_dispatch` inside the built RTOS in unicorn with synthetic recipe, process and
  photo objects: thumbnail rotation among unusable recipes, the half-press gates and box, the getter rules (the camera's
  answer first, category latch, window expiry, end of the AF pass), the sound, the 96-byte record through
  `metadata/read_plain.py`, the direct canvas with the camera's geometry and the cases it must refuse.
- `native_plain_probe.py`: the camera's own code round the hooks: S1 source, the live-view hand-over, the Caf focusing loop,
  category / region / rectangle, the end; cases `subject` (with `--geometry-matrix`: 6 live-view sizes x 3 crops; aspects 7
  and 8 need two added ratios, 65:24 and 2.39:1), `native` / `native_small` / `native_metric99` (a face: the camera's),
  `raw_pending`, `holding`, `manual_select`, `manual_pinpoint`, `manual_f8`, `focuslimit`, `af_range`, `no_frame`, `repeat`,
  `ai_follow`, `ai_continuous`, `face_follow`. (`tracking` is the Follow case of a build without the start frame; with it,
  Follow is `ai_follow` / `face_follow`.)
- `face_follow_rule_probe.py`: the camera's settings recompute for 16 focus modes x 3 face settings on the official RTOS and
  with the three words: exactly one cell changes, Follow with the setting On (Off -> On, eligible 0 -> 1).
- `make_fixture.py`: the frames the replay feeds the module, a synthetic scene (no photo).

Not checked off the camera: whether the camera's tracker follows from the frame placed in Follow / Continuous; half-press
to focus time; the hit rate on the camera's live view. 1.21: emulator only.
