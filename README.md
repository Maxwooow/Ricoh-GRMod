# GR Mod

Desktop firmware customisation for **GR IIIx HDF 1.60** and **GR IV / GR IV HDF 1.11**.
This fork is version **0.6.4-film120-jpg-w2**. Not a Ricoh product.

Both camera families have nine independent film slots with names and colour icons,
while retaining the original Image Controls (including both GR IV Cinema looks).
The library has 120 film entries and package-inspired icons; the owner's local
installation has 119 source LUTs and per-camera fits. Velvia 100F remains an import
placeholder. Choose up to nine films for a firmware, or import an sRGB CUBE yourself.
CUBE transforms are approximated by the camera's matrix and RGB curves, without
spatial grain or halation. Models, source revisions and licences are recorded in
`ui/public/film-library/catalog.json`.

On IIIx, T4 preserves full 6000×4000 RAW and nine ratios; JPEG and embedded previews
follow the selected ratio. Optional SF1 uses Clarity −1/−2/−3 for soft focus. T6-C1
corrects CineStill 800T while keeping the other eight selected films unchanged.
J1 writes the full film name, recipe version and a fingerprint of the actual
quantised parameters to JPEG EXIF UserComment. It does not alter RAW metadata.
All library entries and custom imports use this identity mechanism.

**W2 power-off images are now part of the normal IIIx export.** Choose one image on
the power-off page; exports include it together with the current films and ratios.
No startup script is needed. Selecting the factory image restores the original
shutdown descriptor. W2 adds a 49,116-byte 720×480 JPEG on the normally updated A:
drive instead of replacing the skipped B: resource. Encoding never silently blurs
or adds noise; images that cannot meet this budget are rejected. The app reconstructs
known builds before permitting restoration and checks that every original resource
and every unrelated byte remain intact.

The owner confirmed that T4 resolved wide-ratio flicker, T5-L1 icons work and W2
shows a clear shutdown image. The eight latest W2 JPG/DNG pairs retained correct
film metadata and full RAW. This does not establish hardware coverage for every
library stock or every ratio. GR IV's nine-slot port has software/native-function
validation and still needs a camera test. IIIx XMP, date imprint and a separate
ADJ soft-focus control remain unavailable; J1 metadata and embedded W2 images
have not been ported to GR IV.

See [current app usage](docs/GRMOD_INTEGRATION.txt),
[film library](docs/FILM_LIBRARY_120.txt),
[W2 evidence](docs/GR3X_T6_J1_W2_TEST.txt) and
[reproducible IIIx validation](docs/GR3X_HDF.md).

- `core/`  platform-independent TypeScript: firmware container codec and patcher with built-in self-check (`src/fw`), added aspect ratios (`src/fw/aspect`), preset conversion from .xmp Look profiles and .cube LUTs (`src/color`), exact-length baseline JPEG encoder (`src/jpeg`), start-up script generator and simulator (`src/wallpaper`), memory-card layout planning (`src/card`), and the `Engine` facade (`src/app`).
- `ui/`    React UI (Vite). Talks to the platform through `src/host.ts` only.
- `shell/` Windows/macOS shell in Go (WebView2 window + local HTTP API for drives and files, and for fetching the official firmware from Ricoh's site). See `shell/README.md`.

Build with Node 22+ and Go 1.24+: `npm ci && npm run build`, then `cd shell && ./build.sh windows` or `./build.sh macos`. The macOS build uses the local browser UI.
Test: `npm -w core test` (the byte-identity tests need the official firmware in `core/testdata/private/`, which is not distributed), `cd shell && go test ./...`.

An Android build would reuse `core/` and `ui/` unchanged and replace `shell/` with a WebView wrapper implementing the same host interface (volumes via the Storage Access Framework).

No firmware file is included here. The user picks the supported official file for the chosen camera, or lets the program fetch it: the shell reads Ricoh's own download pages for the chosen model and downloads the current update from there (`shell/internal/ricoh`; Ricoh's page says that downloading means accepting its software licence agreement, and the dialog says so too and links to it). The before/after preview and the frame of an added aspect ratio are drawn on a sample picture, `ui/src/assets/preview.jpg`: DPReview's studio test scene, included with DPReview's permission (it is not covered by the licences of the code). The user can replace it in the UI, or by keeping a `preview.jpg` next to the program (served by `GET /api/sidecar/preview.jpg`). The two card files that open the camera's factory menu (needed once, to switch Script on) are not stored here: `core/src/fw/factory.ts` reads their names, keyword and key out of the user's firmware. `core/src/color/data.ts` holds measurements (the camera's base tone curve and paired calibration colours). The power-off image method builds on the public research in radium-wang/ricoh-gr4-firmware-analysis-and-feature-expansion.

## Public source and local assets

This repository contains code, tests, provenance, licence notices and drawn icons.
It excludes firmware binaries, camera photographs, personal project settings,
research caches and third-party CUBE/Hald/converted parameter payloads. The latter
include sources whose free personal download does not establish redistribution
rights; they are not relicensed as GPL. Existing local assets are left intact.
A clean checkout detects missing LUT inputs and offers **Import CUBE** for those
catalogue entries instead of claiming they are installed. To reuse your own local
library, copy its `cubes/` and `fits/` into `ui/public/film-library/` before building;
all source and fit hashes are checked before use.

Tests needing proprietary fixtures skip when they are absent. Set
`GRMOD_GR3X_FIRMWARE` and `GRMOD_GR4_FIRMWARE` to your official files for integration
checks. `GRMOD_GR3X_W2` optionally points to the camera-tested W2 build for complete
binary reproduction. Native Python checks use the pinned reference and fixtures
documented in the IIIx validation guide. The initial research-library generators
under `tools/film-library/` are optional and require their documented source inputs;
normal builds never download LUTs.

## Added aspect ratios

`core/src/fw/aspect` adds aspect ratios to the camera next to the four factory ones (up to 8; e.g. 65:24 gives 6192×2272 JPEGs). It is a TypeScript port of the crop compiler of [DoYitNow/gr-custom-tool](https://github.com/DoYitNow/gr-custom-tool) and is checked against it: `core/test/aspect-oracle.test.ts` builds 439 configurations (every possible screen geometry, and random lists of up to 8 ratios) and compares them byte for byte with what the reference produced (`tools/aspect/gen_oracle.py`). `tools/aspect/verify_file.py FILE --boot` runs the firmware's own functions of a built file in an emulator. The RTOS and ICONBIN sections of such a file are longer than the official ones; the version stays 1.11.

One thing is added on top of the port (build revision 2, `installPlaybackDecode` in `build.ts`; the end of the RTOS section says `GRMODAR2`, files of GR Mod 0.2.x say `GRMODAR1` and are still recognised). Magnifying a photo in playback decodes the whole JPEG into a buffer the firmware sizes for `align16(width) × height` rows while its decoder asks for `align8(height)`; every factory size has a height that is a multiple of 8, the sizes of added ratios are multiples of 4, and for those the decode step gave up and the playback screen stayed in its magnifying state. The byte count of that allocation is now taken for the height rounded up to 8. `tools/aspect/playback_check.py FILE` runs the firmware's own image creation for every photo size on the official firmware and on FILE.

On a camera: a user reports that a 0.2.x build installs and shoots in the added ratios, and that magnifying such photos got stuck (the reason for revision 2). With revision 2 the user reports that magnifying 65:24 photos works. See `third_party/gr-custom-tool/NOTICE.md` for what is derived from the reference.

## Soft focus

Two generations:

- GR Mod 0.4.x (`core/src/fw/clarity.ts`) rewrote rows of the camera's clarity table (RTOS 0x53b4c860, 9 rows for clarity −4…+4 of 11 int16 gains in Q10, finest band first) so that clarity −2 / −3 / −4 became weak / medium / strong soft focus. Such files are still recognised and verified; the program no longer writes them.
- GR Mod 0.5.2 (`core/src/fw/aspect/softfocus.ts`) puts soft focus on the ADJ lever with four values (off / weak / medium / strong) and leaves the clarity table official. The ADJ controller is table-driven (21 records of member-function pointers at 0x53d9f714, addressed from 23 places). Soft focus takes over function 0x0A (Flash Exposure Comp.), which the GR IV never offers on the ADJ lever (not in the ADJ mode setting list, not in the fixed layout of any camera mode); its record is overwritten in place with Crop's, carrying four new handlers, so the table does not move. The ADJ mode setting list gets 0x0A after Image Control; its name is text 840 in all 21 languages and its icon is icon 720 (bounds never above what added ratios use). The value is kept in byte 0x90F of the user settings, alignment padding that the factory-defaults initialiser never writes; the structure is saved, loaded and copied to U1–U3 as a whole, so the value survives power-off. Whether a picture goes through the digital-filter step at all (0x537150fc) depends on Clarity being non-neutral for most image controls; while soft focus is on it counts as non-neutral. DigitalFilterProcess::SetEffectParameter passes clarity 5 / 6 / 7 while soft focus is on, and the clarity function takes rows 9–11 from a table of the three soft-focus rows. It acts on the recorded picture only: live view does not go through this step. The five ADJ slot getters read a function above 0x14 as off. Built files are revision 3 (`GRMODAR3`): the record at the end of RTOS may list no ratio and carries one more byte for these additions. `tools/softfocus/check.py RTOS.bin official-RTOS.bin` runs the patched functions in an emulator.
- GR Mod 0.5.0 / 0.5.1 used function 0x15 and copied the table to the appended area, moving 22 of its 23 references; the one left (0x531bd0f0, a check over the five slots when ADJ is pressed) read past the official table once 0x15 was on a slot, and the camera froze. A camera that still holds 0x15 in a slot has it read as off from 0.5.2 on; the official firmware would freeze, so take soft focus off the ADJ slots before going back to it.

Clarity is a Laplacian pyramid on the developed picture (RetouchService, 0x538a1fa8): the function copies the table to the stack, returns at once for clarity 0, takes row `clarity + 4` and multiplies each band of detail by its gain through the first diagonal entry of a CSC matrix (the other entries stay 1.0, so luma only, by inference). Lower gains on the fine and middle bands with the coarse ones kept give roughly `g × picture + (1 − g) × strongly blurred picture`, the usual digital soft focus. `core/src/color/clarity.ts` is a model of the pyramid (bilinear scaling assumed). It is linear and works after gamma on the 8-bit picture, so highlights do not bloom. Tried on a camera with 0.5.2: the three strengths are clearly distinct on the recorded picture.

## Date imprint

`core/src/fw/aspect/datestamp.ts` hooks JpegEncodeMacroProcess::Execute (0x537034b4) and runs the position-independent C module `tools/datestamp/datestamp.c` (compiled by `tools/datestamp/gen.py`; `GRMOD_ZIG=1` uses `python3 -m ziglang cc`, the compiler of the committed bytes) on every picture the JPEG encoder is given: main picture, 720x480 screennail, 160x120 thumbnail. It draws the date bottom right (pictures anywhere in 0x40000000..0xBFFFFFFF: with RAW+JPEG the scaled main picture of the smaller JPEG sizes is above 0xA0000000) in orange seven-segment digits, `'26 10 08` or `2026.10.08 17:34`, light only on black-and-white photos. The setting is byte 0x94B of the user settings (padding the factory-defaults initialiser never writes, like 0x90F for soft focus): bit 0 on, bit 1 the long style, anything above 3 is off.

`core/src/fw/aspect/datestamp-menu.ts` puts it in the camera menu: a line after Horizon Correction on the Shooting Assist page of the still menu, opening a submenu (On/Off, Style) built like D-Range Correction's, each line a list built like Horizon Correction's. The still menu already has the maximum of 38 lines, so two descriptors are appended, one without Red Filter (GR IV Monochrome only) and one without HDF (GR IV HDF only), and the menu builder picks the one for the camera's model; every model sees the official menu plus the new line. The submenu and list record tables are relocated with the new records (including the end pointer the list constructor scans to, 0x531d6dac). Texts 841..845, icons 721/722. `tools/datestamp/menu_check.py BUILT-RTOS OFFICIAL-RTOS` runs the patched firmware functions in an emulator (menu builder for all three models, controller factory, SetCurrentMenu, the handlers for every value of the byte, the controllers drawing the new records, the list constructor's table scan, texts and icons); `tools/datestamp/render_check.py` runs the module on synthetic pictures.

## Monochrome looks

`core/src/fw/aspect/monounlock.ts` makes the six looks of the GR IV Monochrome selectable on the colour models, after [lemonadesaltbagel/GR4-MonoUnlock](https://github.com/lemonadesaltbagel/GR4-MonoUnlock) (no code copied): the check at 0x533cc6e0 becomes `cmp r1, #0x18` / `bhi`, and rows 3..8 of the look availability table at 0x53dbf36c (7 bytes per row, one column per camera model, column 1 = Monochrome) get every column except 1. The reference sets column 0 only (the standard GR IV); with every colour column the GR IV HDF has them too. 13 words in all.

## GR IV 1.11 independent film slots

`core/src/fw/gr4/film-slots.ts` adds still-photo identities 64–72 after the factory
list. Each has a private matrix record, RGB curves, name and colour icon. The
factory matrices, curves, names and icons are preserved. Audited native consumers
use Standard as the base while the selected private identity stays in user
settings. Added looks use fixed neutral Image Control parameters; in-camera RAW
development falls back to the factory base look. The existing aspect and RAW
geometry code is unchanged. This port has passed software checks, not a camera test.

The GRMODAR3 feature byte uses bit 3 for films. A bounded, non-executable recipe
records all nine slots. Inspection rebuilds from the official firmware and verifies
the entire file hash. `tools/gr4/native-film9.py` executes the original menu,
selection, RAM commit, descriptor and RAW-enum functions with synthetic memory;
OS mutexes and queue delivery are substituted. Power-cycle persistence, real ISP
output and JPEG/DNG files still require camera validation. The 119 ready library
stocks build in 14 batches with nine-slot capacity; Velvia 100F remains pending.

## The UI

The Image Control page uses model-specific slots: nine scrollable film cards for
both IIIx HDF 1.60 and GR IV 1.11. GR IV keeps every factory look, including
both Cinema entries; CY/CG are retained only as compatible project keys for Film 1/2. The preview selector lists the
available slots. IIIx exposes clarity-table soft focus and hides the retired
Replica switch; GR IV retains its ADJ soft focus, date imprint and supported
monochrome looks. Project settings are saved in `project.json`; the firmware
copies page reads supported recipes back through `Engine.inspect`.

## Combinations

Anything that appends code or icons (ratios, independent films, ADJ soft focus, date imprint) gives the grown layout: RTOS grows, and ICONBIN too when icons are added (a build that only appends code, like the date imprint of a test build with a fixed setting, leaves ICONBIN as it is; `growPayload`, `grownRanges`, `Engine.inspect` and the self-check accept either). The monochrome looks (`core/src/fw/aspect/monounlock.ts`, 13 words) on their own are written in place, like Image Control edits: official layout plus the checksum compensation word; `Engine.inspect` recognises them when all 13 words are there. With any of the other additions they go into the grown build and its feature byte (bit 2). `core/test/combinations.test.ts` builds every combination, checks the self-check and what `inspect` reads back, that soft focus alone is unchanged, and that all additions with the contents of the earlier test firmware (`core/test/fw-helpers/test-firmware.ts`) give test firmware 017 byte for byte. `tools/testfw/build.ts` builds such test files.

## Licence

GR Mod is free software, licensed under the GNU General Public License version 2 only (SPDX: `GPL-2.0-only`); the full text is in `LICENSE`. A build given to anyone else has to come with its complete source under the same licence.

- The aspect-ratio compiler under `core/src/fw/aspect/` and `tools/aspect/` is a port of [DoYitNow/gr-custom-tool](https://github.com/DoYitNow/gr-custom-tool) (GPL-2.0-only); `third_party/gr-custom-tool/NOTICE.md` lists what is derived from it, and the C sources in `third_party/gr-custom-tool/native/` keep their own copyright lines.
- The monochrome looks follow the method of [lemonadesaltbagel/GR4-MonoUnlock](https://github.com/lemonadesaltbagel/GR4-MonoUnlock); no code of that project is included.
- Not covered by the licence: the sample picture `ui/src/assets/preview.jpg` , and Ricoh's firmware, which is not part of this repository (the program reads it from the user or downloads it from Ricoh's site under Ricoh's own licence terms).
