# GR Mod

A small desktop tool for the Ricoh GR IV / GR IV HDF (firmware 1.11). Not a Ricoh product.

- `core/`  platform-independent TypeScript: firmware container codec and patcher with built-in self-check (`src/fw`), added aspect ratios (`src/fw/aspect`), preset conversion from .xmp Look profiles and .cube LUTs (`src/color`), exact-length baseline JPEG encoder (`src/jpeg`), start-up script generator and simulator (`src/wallpaper`), memory-card layout planning (`src/card`), and the `Engine` facade (`src/app`).
- `ui/`    React UI (Vite). Talks to the platform through `src/host.ts` only.
- `shell/` Windows shell in Go (WebView2 window + local HTTP API for drives and files, and for fetching the official firmware from Ricoh's site). See `shell/README.md`.

Build: `npm install && npm -w ui run build && (cd shell && ./build.sh windows)` → `shell/dist/GRMod.exe`.
Test: `npm -w core test` (the byte-identity tests need the official firmware in `core/testdata/private/`, which is not distributed), `cd shell && go test ./...`.

An Android build would reuse `core/` and `ui/` unchanged and replace `shell/` with a WebView wrapper implementing the same host interface (volumes via the Storage Access Framework).

No firmware file is included here. The user picks the official 1.11 file, or lets the program fetch it: the shell reads Ricoh's own download pages for the chosen model and downloads the current update from there (`shell/internal/ricoh`; Ricoh's page says that downloading means accepting its software licence agreement, and the dialog says so too and links to it). The before/after preview and the frame of an added aspect ratio are drawn on a sample picture, `ui/src/assets/preview.jpg`: DPReview's studio test scene, included with DPReview's permission (it is not covered by the licences of the code). The user can replace it in the UI, or by keeping a `preview.jpg` next to the program (served by `GET /api/sidecar/preview.jpg`). The two card files that open the camera's factory menu (needed once, to switch Script on) are not stored here: `core/src/fw/factory.ts` reads their names, keyword and key out of the user's firmware. `core/src/color/data.ts` holds measurements (the camera's base tone curve and paired calibration colours). The power-off image method builds on the public research in radium-wang/ricoh-gr4-firmware-analysis-and-feature-expansion.

## Added aspect ratios

`core/src/fw/aspect` adds aspect ratios to the camera next to the four factory ones (up to 8; e.g. 65:24 gives 6192×2272 JPEGs). It is a TypeScript port of the crop compiler of [DoYitNow/gr-custom-tool](https://github.com/DoYitNow/gr-custom-tool) and is checked against it: `core/test/aspect-oracle.test.ts` builds 439 configurations (every possible screen geometry, and random lists of up to 8 ratios) and compares them byte for byte with what the reference produced (`tools/aspect/gen_oracle.py`). `tools/aspect/verify_file.py FILE --boot` runs the firmware's own functions of a built file in an emulator. The RTOS and ICONBIN sections of such a file are longer than the official ones; the version stays 1.11.

One thing is added on top of the port (build revision 2, `installPlaybackDecode` in `build.ts`; the end of the RTOS section says `GRMODAR2`, files of GR Mod 0.2.x say `GRMODAR1` and are still recognised). Magnifying a photo in playback decodes the whole JPEG into a buffer the firmware sizes for `align16(width) × height` rows while its decoder asks for `align8(height)`; every factory size has a height that is a multiple of 8, the sizes of added ratios are multiples of 4, and for those the decode step gave up and the playback screen stayed in its magnifying state. The byte count of that allocation is now taken for the height rounded up to 8. `tools/aspect/playback_check.py FILE` runs the firmware's own image creation for every photo size on the official firmware and on FILE.

On a camera: a user reports that a 0.2.x build installs and shoots in the added ratios, and that magnifying such photos got stuck (the reason for revision 2). With revision 2 the user reports that magnifying 65:24 photos works. See `third_party/gr-custom-tool/NOTICE.md` for what is derived from the reference.

## Soft focus

`core/src/fw/clarity.ts` rewrites rows of the camera's clarity table (RTOS 0x53b4c860, 9 rows for clarity −4…+4 of 11 int16 gains in Q10, finest band first). Clarity is a Laplacian pyramid on the developed picture (RetouchService, 0x538a1fa8): the function copies the table to the stack, returns at once for clarity 0, takes row `clarity + 4` and multiplies each band of detail by its gain through the first diagonal entry of a CSC matrix (the other entries stay 1.0, so luma only, by inference). Lower gains on the fine and middle bands with the coarse ones kept give roughly `g × picture + (1 − g) × strongly blurred picture`, the usual digital soft focus. In the UI it is one switch on the Image Control page: on, clarity −2 / −3 / −4 get fixed weak / medium / strong gains (−1 and the positive steps stay as they are), so the photographer switches by changing Clarity in the camera. The core accepts any of −4…+4 with any gains (`ClarityEdit`). It is a same-length data edit of 198 bytes plus the checksum compensation word, recognised and verified on the copies page like the other edits. `core/src/color/clarity.ts` is a model of the pyramid (bilinear scaling assumed, the camera's interpolation is not known), used by the tests to check that the three strengths soften in order. It is linear and works after gamma on the 8-bit picture, so highlights do not bloom. Not tried on a camera yet.

## Licence

The files under `core/src/fw/aspect/`, `tools/aspect/` and `third_party/gr-custom-tool/`, and the aspect-ratio tests, are derived from gr-custom-tool and are GPL-2.0-only (see the SPDX line in each file and `third_party/gr-custom-tool/LICENSE`). They are compiled into the program, so a build that is given to anyone else has to be distributed under GPL-2.0 together with its complete source.

