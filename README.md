# GR Mod

A small desktop tool for the Ricoh GR IV / GR IV HDF (firmware 1.11). Not a Ricoh product.

- `core/`  platform-independent TypeScript: firmware container codec and patcher with built-in self-check (`src/fw`), preset conversion from .xmp Look profiles and .cube LUTs (`src/color`), exact-length baseline JPEG encoder (`src/jpeg`), start-up script generator and simulator (`src/wallpaper`), memory-card layout planning (`src/card`), and the `Engine` facade (`src/app`).
- `ui/`    React UI (Vite). Talks to the platform through `src/host.ts` only.
- `shell/` Windows shell in Go (WebView2 window + local HTTP API for drives and files). See `shell/README.md`.

Build: `npm install && npm -w ui run build && (cd shell && ./build.sh windows)` → `shell/dist/GRMod.exe`.
Test: `npm -w core test` (the byte-identity tests need the official firmware in `core/testdata/private/`, which is not distributed), `cd shell && go test ./...`.

An Android build would reuse `core/` and `ui/` unchanged and replace `shell/` with a WebView wrapper implementing the same host interface (volumes via the Storage Access Framework).

The user supplies the firmware file; no firmware file is included here. The before/after preview is drawn on a `preview.jpg` the user keeps next to the program (served by `GET /api/sidecar/preview.jpg`) or picks in the UI; no photograph is included either. The two card files that open the camera's factory menu (needed once, to switch Script on) are not stored here: `core/src/fw/factory.ts` reads their names, keyword and key out of the user's firmware. `core/src/color/data.ts` holds measurements (the camera's base tone curve and paired calibration colours). The power-off image method builds on the public research in radium-wang/ricoh-gr4-firmware-analysis-and-feature-expansion.
