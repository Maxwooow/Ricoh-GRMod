# GR Mod for Android

The GR Mod app on the phone: the same UI as the desktop app (`../ui`, built with `vite --mode android`), with two
ways out instead of a memory card:

- **Push to camera** (GR IV family only: GR IV, HDF, Monochrome): over Bluetooth and Wi-Fi, the way GR WORLD does.
  The camera has to be on the same base version as the file (1.20 → 1.20).
- **Save to phone**: `Download/GR Mod/fwdc248b.bin` (MediaStore), to copy to a card by other means. Every model.

The official firmware is downloaded on the phone (Ricoh's site, SHA-256 checked, same pinned list as the desktop
app in `Ricoh.java`); GR Mod firmware is built in the WebView by `../core`, exactly as on the desktop.

## Layout

- `www/` is build output (gitignored): `npm run ui` builds `../ui` into it.
- `android/` is the Capacitor 8 project. The native side is in
  `android/app/src/main/java/io/github/maxwooow/grmod/push/`:
  - `GrCameraPlugin` — everything the UI calls (`ui/src/host-android.ts`, `ui/src/camera.tsx`): permissions,
    camera scan, push session, app storage (settings, downloaded firmware), Ricoh downloads, saving to Downloads,
    sharing the push log.
  - `PushSession` runs one push: Bluetooth (pair if needed, camera Wi-Fi on, SSID/passphrase), joins the camera's
    access point with a `WifiNetworkSpecifier` of the app's own, checks `/v1/props` against the file, keeps
    `ws://192.168.0.1/v1/changes` open, `prepare` + one `PUT`, then reconnects Bluetooth and writes `01` to
    CameraService FirmwareUpdateStart (`5F0A7BA9-…`) and waits up to 200 s for FirmwareUpdateResult (`39879AAC-…`).
  - `Ble` (one GATT operation at a time), `CameraNet` (HTTP and the WebSocket bound to the camera's network only),
    `FirmwareInfo` (header and model records of the file), `Ricoh` (official firmware pages and downloads),
    `Downloads`, `PushLog`.
  - The protocol, the UUIDs and how they were found: `04_研究与样片/GRIV无线推送固件_2026-11-11/已知情况.md`
    in the project folder; tested end to end on 2026-11-11.
- minSdk 29 (Android 10: `WifiNetworkSpecifier`), target/compile 36.

Safety rules in `PushSession`: nothing is retried once the PUT has started; before that every failure ends with a
cancel; model, base version, battery (≥ 50 %) and "hot" are checked first; without the final `01` the camera does
not update (it shows "processing failed" after a few minutes and stays as it was).

Not on Android yet: the guided tours, the copies page (no card), in-app updates (install the new APK from the
releases page).

## Build

```sh
npm install                       # in the repository root (core, ui) and in mobile/
cd mobile
npm run sync                      # builds ../ui into www/ and copies it into the Android project
cd android && echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleDebug testDebugUnitTest lintDebug   # app/build/outputs/apk/debug/app-debug.apk
```

Needs JDK 21 and the Android SDK (platform 36, build-tools 36). `FirmwareInfoTest` reads
`core/testdata/private/official120.bin` when it is there and is skipped otherwise; `RicohTest` also checks the
live Ricoh pages.
