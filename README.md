# GR Mod

Customize your Ricoh GR with your own Image Control presets, aspect ratios, and power-off images—plus additional shooting and display options.

**[Download for Windows, macOS, or Android](https://github.com/Maxwooow/Ricoh-GRMod/releases)** · **[Get the iPhone and iPad app](https://apps.apple.com/app/id6834232648)**

> GR Mod is an independent, open-source project. It is not a Ricoh product.

<p align="center">
  <img src="docs/images/mobile-overview-en.png" width="32%" alt="GR Mod on iPhone, iPad and Android">
  <img src="docs/images/whats-new-0.8.14-0.9.1-en.jpg" width="32%" alt="What's new in GR Mod from 0.8.14 to 0.9.1">
  <img src="docs/images/download-guide-en.png" width="32%" alt="Download GR Mod for desktop and Android from GitHub, or for iPhone and iPad from the App Store">
</p>

## Download

| Platform | Download |
| --- | --- |
| Windows | [Latest release](https://github.com/Maxwooow/Ricoh-GRMod/releases) |
| macOS | [Latest release](https://github.com/Maxwooow/Ricoh-GRMod/releases) |
| Android | APK from the [latest release](https://github.com/Maxwooow/Ricoh-GRMod/releases) |
| iPhone and iPad | [App Store: GR Mod - For Ricoh GR IV/III](https://apps.apple.com/app/id6834232648) |
| Linux | [Build from source](#build-from-source); no prebuilt package is currently provided |

See [Releases](https://github.com/Maxwooow/Ricoh-GRMod/releases) for the latest version and release notes.

## Supported cameras and firmware

<!-- BEGIN releases (written by tools/releases/generate.mjs from releases.json) -->

| Camera | Supported firmware |
| --- | --- |
| GR IV / GR IV HDF | 1.21, 1.20 or 1.11 |
| GR IV Monochrome | 1.11 or 1.10 (the same files as GR IV 1.21 and 1.20) |
| GR III / GR III HDF | 2.21, 2.20 or 2.10 |
| GR IIIx / GR IIIx HDF | 1.71, 1.70 or 1.60 |

<!-- END releases -->

Use only firmware intended for your camera model and a base version listed above.

## Features

- **Image Control presets:** add your own looks from `.cube` LUTs or `.xmp` profiles, adjust their parameters, and reorder or hide looks in the camera menu.
- **Aspect ratios:** add custom ratios alongside the camera's factory options; on the GR IV (firmware 1.11, 1.20 and 1.21) the live view can also show the whole frame with the outside darkened (on 1.20 / 1.21 how bright is chosen in the camera menu Matte Brightness: black, 75 %, 50 %, 25 % or none; movie mode shows the plain picture).
- **Power-off images:** add your own End Screen pictures and choose between them in the camera.
- **Soft focus and halation:** create softer images and red or white highlight effects.
- **Date imprint:** add a shooting date, date and time, and optionally the Image Control name to JPEGs.
- **Monochrome looks:** use supported GR IV Monochrome looks on colour GR IV models.
- **Flash enhancements:** Direct Flash (guide-number-based flash exposure) and, on GR IV 1.20 / 1.21, pre-flash (TTL) metering for a GF-2 in the two red-eye flash modes.
- **HDR gain maps:** create JPEGs with brighter highlights on compatible HDR displays.
- **More ADJ options:** add ADJ lever slots on supported GR IV firmware.
- **Battery percentage:** show the charge as a number in steps of 10 % instead of bars, on the GR IV (firmware 1.11, 1.20 and 1.21).
- **Exposure preview and display options:** access additional preview and automatic screen-brightness settings on supported GR IV firmware.
- **Shadow Correction, learned Auto:** Auto lifts the shadows by an amount estimated from the scene, on the GR IV (firmware 1.11, 1.20 and 1.21).
- **Film grain:** an optimized film grain in place of the camera's Grain Effect, on GR IV 1.20 / 1.21.
- **Phase Detect AF for Video:** while recording, the sensor's phase data drives the lens, with less focus hunting, on GR IV 1.20 / 1.21.
- **Exposure Control in Video Mode:** movies are recorded in the mode dial's exposure mode (P / Av / Tv / M) instead of always in P, with aperture, shutter speed and ISO shown and adjustable, on GR IV 1.20 / 1.21.
- **4K Video:** the movie menu's Framerate becomes Framerate / Resolution; 4K (3840×2160) at 30p and 24p, on GR IV 1.20 / 1.21.
- **Sensor-Shift SR in Video Mode:** Movie SR offers Off, Mechanical (sensor shift) and Electronic; Off and Mechanical record the whole picture without the electronic shake reduction's crop, on GR IV 1.20 / 1.21.
- **Learned auto white balance:** Auto, Warmth Priority and White Priority estimate the light with a learned model, on GR IV 1.20 / 1.21.
- **Constant Light:** keeps the AF assist lamp lit, switched in the shooting menu, in ADJ mode or by an Fn button, on GR IV 1.20 / 1.21.
- **Sensor Shift:** shift and turn the sensor by hand with the shake reduction unit to fine-tune the framing, from ADJ mode, the Fn button or the held Movie button, on GR IV 1.20 / 1.21.
- **Distance unit:** Snap Focus Distance and the manual focus scale in feet (and inches) instead of metres, on GR IV 1.20 / 1.21.
- **Custom grid lines:** choose which lines a 3x3 and a 4x4 grid draw, on the GR IV (firmware 1.11, 1.20 and 1.21; on 1.20 / 1.21 they are extra values of the camera's Grid Style list, next to its own).

Features vary by camera model and firmware version. The app only offers options supported by the selected firmware.

## Quick start

### Windows and macOS

1. Download and open GR Mod.
2. Select your camera and a supported firmware version.
3. Open your own official Ricoh firmware file, or let GR Mod download it from Ricoh's website.
4. Choose the features and presets you want, then follow the app's instructions to write the modified firmware to a memory card.
5. Install the firmware on the camera using its normal firmware-update process.

**macOS first launch:** unzip `GRMod-mac.zip` and move `GR Mod.app` to Applications. The app is signed ad hoc rather than with an Apple Developer ID. If macOS blocks it, open **System Settings › Privacy & Security** and select **Open Anyway**. Allow access to removable volumes when macOS asks; otherwise, GR Mod cannot write to the memory card.

### Android, iPhone, and iPad

1. Install the app and select your camera and firmware.
2. Choose your customizations.
3. Save the finished firmware to your device, or send it directly to a supported GR IV over Bluetooth and Wi-Fi.

Wireless transfer requires the firmware's base version to match the version currently installed on the camera. See the [mobile guide](mobile/README.md) for platform requirements and transfer details.

## Restore factory firmware

Before returning to the official firmware, reset the camera to factory defaults. Settings created by GR Mod—such as an added look, aspect ratio, or ADJ function—may not be understood by the official firmware.

You can restore the official firmware from the Image Control page or the firmware copies page. After installing a newer official Ricoh firmware, you may not be able to return to an earlier version.

> **Use modified firmware at your own risk.** Check the model and firmware version carefully, keep the camera sufficiently charged, and do not interrupt a firmware update.

## Documentation

- [Mobile app guide](mobile/README.md)
- [Desktop shell guide](shell/README.md)
- [Automatic screen brightness](docs/bright-auto.md)
- [Development guide](docs/development.md)—tests, the generated files, adding a firmware release
- [Releasing](docs/releasing.md)—version numbers, packages, signing, publishing
- [Technical notes and release archive](docs/technical-notes.md)—implementation details, emulator checks, firmware research, and earlier release notes

GR Mod does not include Ricoh firmware. It reads a firmware file supplied by the user or downloads one from Ricoh's official website under Ricoh's licence terms.

## Build from source

From the repository root:

```sh
npm install
npm -w ui run build
cd shell
```

Then build for your platform:

| Command | Output |
| --- | --- |
| `./build.sh windows` | `dist/GRMod.exe` |
| `./build.sh mac` | `dist/GR Mod.app` and `dist/GRMod-mac.zip` |
| `./build.sh linux` | `dist/grmod` (x64) |

On macOS and Linux, GR Mod opens in a supported Chromium-based browser when available, or in the default browser. On Linux, the memory card must be mounted before it appears in the app; the folder picker requires `kdialog` or `zenity`.

### Run tests

```sh
npm run check        # generated lists, version numbers and firmware ports are in step
npm run typecheck
npm test             # core (engine) and ui
cd shell
./build.sh dev && ./smoke.sh
go test ./...
go test -tags desktop ./...
```

The same checks run on GitHub for every push and pull request (`.github/workflows/test.yml`). Some byte-identity tests require official firmware files, which are not distributed with this repository; see the [development guide](docs/development.md).

See the [mobile guide](mobile/README.md) for Android and iOS build instructions.

## Licence and acknowledgements

GR Mod is free software licensed under [GNU GPL version 2 only](LICENSE) (`GPL-2.0-only`).

- The aspect-ratio compiler is based on [DoYitNow/gr-custom-tool](https://github.com/DoYitNow/gr-custom-tool).
- The Monochrome unlock follows the method of [lemonadesaltbagel/GR4-MonoUnlock](https://github.com/lemonadesaltbagel/GR4-MonoUnlock); no code from that project is included.
- The power-off image method builds on public research from [radium-wang/ricoh-gr4-firmware-analysis-and-feature-expansion](https://github.com/radium-wang/ricoh-gr4-firmware-analysis-and-feature-expansion).

The sample image `ui/src/assets/preview.jpg` and Ricoh firmware are not covered by the project's software licence.

## Star History

[![Ricoh-GRMod stars over time](https://api.star-history.com/chart?repos=Maxwooow%2FRicoh-GRMod&type=date&format=svg)](https://www.star-history.com/?repos=Maxwooow%2FRicoh-GRMod&type=date)
