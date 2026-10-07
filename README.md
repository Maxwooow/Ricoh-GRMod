# GR Mod

A small desktop tool for the Ricoh GR IV / GR IV HDF (firmware 1.11). Not a Ricoh product.

- `core/`  platform-independent TypeScript: firmware container codec and patcher with built-in self-check (`src/fw`), added aspect ratios (`src/fw/aspect`), preset conversion from .xmp Look profiles and .cube LUTs (`src/color`), exact-length baseline JPEG encoder (`src/jpeg`), start-up script generator and simulator (`src/wallpaper`), memory-card layout planning (`src/card`), and the `Engine` facade (`src/app`).
- `ui/`    React UI (Vite). Talks to the platform through `src/host.ts` only.
- `shell/` Windows shell in Go (WebView2 window + local HTTP API for drives and files). See `shell/README.md`.

Build: `npm install && npm -w ui run build && (cd shell && ./build.sh windows)` → `shell/dist/GRMod.exe`.
Test: `npm -w core test` (the byte-identity tests need the official firmware in `core/testdata/private/`, which is not distributed), `cd shell && go test ./...`.

An Android build would reuse `core/` and `ui/` unchanged and replace `shell/` with a WebView wrapper implementing the same host interface (volumes via the Storage Access Framework).

The user supplies the firmware file; no firmware file is included here. The before/after preview and the frame of an added aspect ratio are drawn on a sample picture, `ui/src/assets/preview.jpg`: DPReview's studio test scene, included with DPReview's permission (it is not covered by the licences of the code). The user can replace it in the UI, or by keeping a `preview.jpg` next to the program (served by `GET /api/sidecar/preview.jpg`). The two card files that open the camera's factory menu (needed once, to switch Script on) are not stored here: `core/src/fw/factory.ts` reads their names, keyword and key out of the user's firmware. `core/src/color/data.ts` holds measurements (the camera's base tone curve and paired calibration colours). The power-off image method builds on the public research in radium-wang/ricoh-gr4-firmware-analysis-and-feature-expansion.

## Added aspect ratios

`core/src/fw/aspect` adds aspect ratios to the camera next to the four factory ones (up to 8; e.g. 65:24 gives 6192×2272 JPEGs). It is a TypeScript port of the crop compiler of [DoYitNow/gr-custom-tool](https://github.com/DoYitNow/gr-custom-tool) and is checked against it: `core/test/aspect-oracle.test.ts` builds 439 configurations (every possible screen geometry, and random lists of up to 8 ratios) and compares them byte for byte with what the reference produced (`tools/aspect/gen_oracle.py`). `tools/aspect/verify_file.py FILE --boot` runs the firmware's own functions of a built file in an emulator. The RTOS and ICONBIN sections of such a file are longer than the official ones; the version stays 1.11.

Not verified on a camera. See `third_party/gr-custom-tool/NOTICE.md` for what is derived from the reference.

## Licence

The files under `core/src/fw/aspect/`, `tools/aspect/` and `third_party/gr-custom-tool/`, and the aspect-ratio tests, are derived from gr-custom-tool and are GPL-2.0-only (see the SPDX line in each file and `third_party/gr-custom-tool/LICENSE`). They are compiled into the program, so a build that is given to anyone else has to be distributed under GPL-2.0 together with its complete source.

