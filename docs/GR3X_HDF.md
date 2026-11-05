# GR IIIx HDF 1.60 support

This port targets GR IIIx HDF using Ricoh's official `fwdc243b.bin` 1.60 file.
The IIIx variants share a firmware container; the physical target tested here is
IIIx HDF. GR III and other firmware versions are not supported by this port.
The existing GR IV engine, presets and menu paths remain model-specific.

## Features and camera evidence

| Feature | Implementation | Evidence as of 2026-10-12 |
| --- | --- | --- |
| Nine aspect ratios | ADJ, regular menu and assigned Fn use `4:3 / 3:2 / 16:9 / 65:24 / 17:6 / 3:4 / 1:1 / 7:6 / 5:4` | Camera owner tested captures and reported T4 fixed wide post-capture flicker |
| Full RAW | Only the DNG descriptor path forces the full 6000×4000 default crop; JPEG and embedded previews follow the selected ratio | Repeated JPG/DNG sets decoded; 6112×4064 sensor mosaic, DefaultCropOrigin=(10,12), DefaultCropSize=(6000,4000) |
| Wide live view | Preserve native 3:2 buffer width and align custom crop heights/ROI starts to four-row groups | Differential native probes reproduce T2/T3 failures; owner confirmed T4 flicker gone |
| Soft focus | Optional Clarity −1/−2/−3 table changes, weak/medium/strong; 0, −4 and positive levels retain factory behaviour | SF1 JPG effects observed with HDF off; independently developed RAW retains detail |
| CUBE import | Fit display-sRGB CUBE to IIIx's matrix and three RGB curves | Two synthetic T5 examples tested on camera; not execution of the complete 3D LUT |
| Nine film slots | IDs 64–72, independent matrices/curves, names and icons; keep the 12 factory controls and Custom 1/2 | T6 passes software/native checks; nine real film presets await camera testing |
| Icon queries | Cover the common list, ADJ and shooting-state lookup entry | Owner confirmed T5-L1 icons display; T6 packaging palettes await camera confirmation |
| Script and power-off images | IIIx factory entry, fixed-size JPEG creation, rotation and factory restoration | Local and bounded native-function checks; not yet camera-tested |

The earlier six monochrome styles are explicit IIIx **Replica** recipes, not an
unlock of GR IV Monochrome algorithms. They and the two synthetic demo films are
retained as reconstruction/test support but absent from the T6 configuration.
Intermittent idle jitter stopped reproducing; no stabilisation or jitter patch
was made and no fix is claimed for it.

## Scope and limitations

- IIIx XMP import, date imprint and independent ADJ soft-focus control are not implemented.
- Added film parameters are fixed. EXIF and in-camera RAW development use the
  factory base (Standard for added colour films), not a new film-specific EXIF enum.
- CUBE conversion is approximate. Gold/Ektar need careful comparison; CineStill
  provides colour/tonal treatment without spatial halation.
- Names use 1–24 printable ASCII characters. UI project IDs CY/CG are retained
  for old projects; T6 offers CY/CG/F3…F9, mapped to camera IDs 64…72.
- Persisted T5 look IDs may select different T6 films. Recheck saved/U-mode look
  selections after updating; power-loss/U-mode persistence of T6 awaits testing.
- Native probes use synthetic objects and stub selected services. They do not
  emulate a complete camera, sensor/ISP, DMA, event timing, storage or boot.
- Firmware integration tests require a developer-supplied official image.
  Upstream GR IV private/oracle fixtures are not redistributed here.

## Upstream integration

This contribution is based on upstream `main` at `d2145e7`. Upstream already has
a separate `mac-version` branch with macOS support; the local experimental Mac
wrapper is not contributed again here. Likewise, upstream `extra-slots` and
`second-matrix` are GR IV work. This port owns a distinct IIIx native layout and
needs coordination when those shared UI/colour changes are merged into main.

## Architecture

`core/src/fw/gr3x/` owns IIIx address guards, geometry, metadata, AE/AWB mappings,
RAW development and shading adapters, live view, image controls and resources.
`core/src/color/gr3x-*` provides the IIIx colour model/import path. `Engine` and
the UI route by firmware family/capabilities rather than applying GR IV addresses.
The IIIx icon records are 8 bytes, distinct from GR IV's 12-byte format.

T4 corrects 1008×448 live-view wide crop heights/starts:
16:9 378/35 → 376/36; 65:24 246/101 → 244/102; 17:6 238/105 → 236/106.
JPEG and RAW dimensions are unchanged by this alignment correction.
The IIIx container keeps its header, empty model records and untouched sections;
RTOS/icon additions are checked and the version remains 1.60.

## Validation record

[The local validation summary](GR3X_VALIDATION.json) records 171 passing tests
(including 21 UI-state tests), 112 skips for unavailable upstream private
fixtures, TypeScript/UI builds, Go tests, Windows vet, and 16 bounded native
probe groups. The reconstructed T6 SHA-256 matches the locally delivered
candidate. This does not establish T6 camera or persistence behaviour.

## Reproduce software checks

Use Node.js 24 (scripts use `registerHooks` and native TypeScript), Go 1.24,
Python 3, and Ricoh's official GR IIIx 1.60 update downloaded separately.
The required input SHA-256 is
`708e79f3b7b96a7e1581b4acf4c412233050a1832718ef7f06c8397db1b431c7`.
No camera, card, original firmware, personal photograph or firmware dump is
included in this contribution.

```sh
npm ci
npm -w core run typecheck
npm -w ui run typecheck
GRMOD_GR3X_FIRMWARE=/path/to/official/fwdc243b.bin npm -w core test
npm -w core exec vitest run test/gr3x-ui.test.mjs
npm -w ui run build
(cd shell && ./build.sh dev && go test ./...)
# Optional Windows compilation check:
(cd shell && GOOS=windows GOARCH=amd64 go vet ./...)
```

## Native validation and local T6 generation

```sh
python3 -m venv /tmp/gr3x-probes
/tmp/gr3x-probes/bin/pip install -r tools/gr3x/requirements.txt

git clone https://github.com/DoYitNow/gr-custom-tool.git /tmp/gr-custom-tool
git -C /tmp/gr-custom-tool checkout 0c15c8f9a97b464ac23ab1641740a8263e0068b0

# Builds the T4 capture baseline and runs independent/native validators.
# Output directory must not already exist; no SD card is discovered or written.
node --experimental-transform-types tools/gr3x/build-test.mjs /path/to/official/fwdc243b.bin \
  /path/to/new-T4-output /tmp/gr3x-probes/bin/python /tmp/gr-custom-tool

# Optional: download the pinned third-party LUTs for local testing.
/tmp/gr3x-probes/bin/pip install -r tools/gr3x/lut-requirements.txt
/tmp/gr3x-probes/bin/python tools/gr3x/prepare-t6-luts.py
node --experimental-transform-types tools/gr3x/build-t6.mjs /path/to/official/fwdc243b.bin \
  /path/to/new-T6-output /tmp/gr3x-probes/bin/python /tmp/gr-custom-tool
```

The small historical T2/T3 executable-patch fixtures in `tools/gr3x/fixtures/`
make the differential probes runnable without the private research directory.
They omit icon pixel payloads. Hashes bind the fixtures and generated reports.
Note (2026-10-21): T6 films now share Standard's adjustable parameters (camera test
on GR III: fixed parameters washed out after the detail page, then could not be adjusted)
newly generated T6 files differ from the hash below.
Generation leaves `UNVALIDATED.bin` until every required check passes, then
assigns the update filename. The expected local T6 SHA-256 is
`b236813463a3da13d9d3000a0769f655654e7a10f855efb1e4def48f7694aa37`.
A matching file proves reconstruction of that candidate, not camera operation.

The pre-generated AE/AWB native template has its C source in
`tools/gr3x/native/map.c`; `compile_map.py` uses ARM-target clang to regenerate it.
Pinned LUT provenance, icon references and distribution notes are in
[examples/gr3x/T6](../examples/gr3x/T6/README.md).
See [T6 camera test procedure](GR3X_T6_TEST.txt) for the existing Chinese guide.
