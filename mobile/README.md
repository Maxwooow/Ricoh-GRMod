# GR Mod for Android (wireless firmware push)

Phase 2 prototype: pick a camera and a ready-made `fwdc248b.bin`, push it over Wi-Fi the way GR WORLD does.
Only the GR IV family (GR IV, HDF, Monochrome), and only a file of the same base version as the camera (1.20 → 1.20).

- `www/` is the page (plain HTML/JS, no build step). Later the GR Mod UI (`../ui`) takes its place.
- `android/` is the Capacitor 8 project. Everything that touches the camera is native, in
  `android/app/src/main/java/io/github/maxwooow/grmod/push/`:
  - `PushSession` runs one push: Bluetooth (pair if needed, camera Wi-Fi on, SSID/passphrase), joins the camera's
    access point with a `WifiNetworkSpecifier` of the app's own, checks `/v1/props` against the file, keeps
    `ws://192.168.0.1/v1/changes` open, `prepare` + one `PUT`, then reconnects Bluetooth and writes `01` to
    CameraService FirmwareUpdateStart (`5F0A7BA9-…`) and waits up to 200 s for FirmwareUpdateResult (`39879AAC-…`).
  - `Ble` (one GATT operation at a time), `CameraNet` (HTTP and the WebSocket bound to the camera's network only),
    `FirmwareInfo` (header and model records of the file), `GrCameraPlugin` (what the page calls), `PushLog`.
  - The protocol, the UUIDs and how they were found: `04_研究与样片/GRIV无线推送固件_2026-11-11/已知情况.md`
    in the project folder; tested end to end on 2026-11-11 with the desktop tool and nRF Connect.
- minSdk 29 (Android 10: `WifiNetworkSpecifier`), target/compile 36.

Safety rules in `PushSession`: nothing is retried once the PUT has started; before that every failure ends with a
cancel; model, base version, battery (≥ 50 %) and "hot" are checked first; without the final `01` the camera does
not update (it shows "processing failed" after a few minutes and stays as it was).

## Build

```sh
npm install
npx cap sync android
cd android && echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleDebug testDebugUnitTest lintDebug   # app/build/outputs/apk/debug/app-debug.apk
```

Needs JDK 21 and the Android SDK (platform 36, build-tools 36). `FirmwareInfoTest` reads
`core/testdata/private/official120.bin` when it is there and is skipped otherwise.
