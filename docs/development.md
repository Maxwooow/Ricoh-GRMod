# Development guide

How the repository is laid out, what is generated from what, and how to check a change. For building the
programs see the [README](../README.md#build-from-source), [shell/README.md](../shell/README.md) and
[mobile/README.md](../mobile/README.md).

## Layout

| Directory | What |
| --- | --- |
| `core/` | The engine (TypeScript, no platform APIs): reads an official firmware file and builds the modified one. `core/src/fw` holds one program per supported firmware release. |
| `ui/` | The React interface, the same for every platform. `src/store/` is the state, `src/pages/` the pages; it reaches the platform only through `src/host.ts` (desktop) and `src/host-android.ts` (phone). |
| `shell/` | The desktop program (Go): serves the UI, reads and writes cards, downloads firmware, updates itself. |
| `mobile/` | The Android and iOS apps (Capacitor around `ui/`), with the wireless push to the camera. |
| `tools/` | Development tools: the camera-side C modules and their emulator checks, the ports to new firmware, and the scripts below. |

## One source for each fact

Three things used to be written in several places by hand. Each now has one source and a script that writes
the rest; `npm run check` (and the Tests workflow) fails when they are out of step.

| Fact | Source | Script | Written into |
| --- | --- | --- | --- |
| The official firmware releases GR Mod builds on | `releases.json` | `node tools/releases/generate.mjs` | `shell/internal/ricoh/releases_gen.go`, `Ricoh.java`, `Ricoh.swift`, `ui/src/releases.gen.ts`, the README's table |
| The version numbers | `package.json` (desktop), `mobile/package.json` (phone) | `node tools/version.mjs desktop X.Y.Z` / `mobile X.Y.Z` | the lock files, `build.gradle` (`versionName`, `versionCode`), the Xcode project |
| The generated copies (GR IV 1.20's program, every later release's development tools) | what they were ported from, the address map and the `.patch` in `tools/port` | `python3 tools/port/generate.py tools/port/NAME.json` | `core/src/fw/gr4v120`, `tools/gr4v120`, `tools/gr4v121`, `tools/gr3x170`, `tools/gr3x171` |
| The address table of a release that shares its program | the address maps in `tools/port` | `python3 tools/port/addresses.py` | `core/src/fw/gr4v121/addresses.ts`, `gr3x170/addresses.ts`, `gr3x171/addresses.ts` |

### One program, several releases

GR IV 1.20 and 1.21 are one program, `core/src/fw/gr4v120`; GR III / IIIx 2.10 / 1.60, 2.20 / 1.70 and
2.21 / 1.71 are one program, `core/src/fw/gr3x`. A program's addresses are those of the release it is
written for and go through `adr(...)`, which for a later release looks them up in that release's
table; the few other values that differ are `byRelease({...})`, and code Ricoh changed is a branch on
`release` (`core/src/fw/release.ts`). The later releases' directories (`gr4v121`, `gr3x170`, `gr3x171`)
hold only their own files. `core/overlays.mjs`, a small Vite plugin, loads the program's modules again
under such a directory's paths so that they take its target. It is in every pipeline that loads the
engine (core's and ui's Vitest, ui's build and its worker, the root `vite.config.mjs` for vite-node);
without it the import of such a directory does not resolve and the build stops. The `.d.ts` files there
tell the type checker what the plugin does. Only GR IV 1.20 is still a generated copy (of the 1.11
program).

### Adding a firmware release

1. Port the program ([tools/port/README.md](../tools/port/README.md): a new address table where the program has a target, a generated copy otherwise) and test it in the emulator and on a camera.
2. Add the release to `releases.json`: the archive's name, size and SHA-256 on Ricoh's site, and the SHA-256 of
   the `.bin` inside (`firmwareSha256`, which must be the one the new program's `profile.ts` accepts).
3. `node tools/releases/generate.mjs`, then `npm run check`.
4. Add the engine's program to `core/src/app/engine.ts` (`GR4_PROGRAMS` / `GR3_PROGRAMS`) and export its version
   from `core/src/index.ts`; `ui/test/releases.test.ts` then compares the list with the engine.

## Tests

```sh
npm run check && npm run typecheck && npm test
cd shell && ./build.sh dev && ./smoke.sh && go test ./... && go test -tags desktop ./...
cd mobile/android && ./gradlew testDebugUnitTest lintDebug     # needs `npm run sync` in mobile/ first
```

- `core/test`: the engine. Tests that build firmware need Ricoh's official files, which are not in the
  repository; without them those tests are skipped (so a green run on GitHub says less than a local run with
  the files). Put the files where the tests look:

  | File | Where |
  | --- | --- |
  | GR IV 1.11 `fwdc248b.bin` | `core/testdata/private/official.bin` |
  | GR IV 1.20 | `core/testdata/private/official120.bin` and `GRMOD_GR4_120_FIRMWARE` |
  | GR IV 1.21 | `GRMOD_GR4_121_FIRMWARE` |
  | GR III 2.10 / 2.20 / 2.21 `fwdc239b.bin` | `GRMOD_GR3_FIRMWARE`, `GRMOD_GR3_220_FIRMWARE`, `GRMOD_GR3_221_FIRMWARE` |
  | GR IIIx 1.60 / 1.70 / 1.71 `fwdc243b.bin` | `GRMOD_GR3X_FIRMWARE`, `GRMOD_GR3X_170_FIRMWARE`, `GRMOD_GR3X_171_FIRMWARE` |

  Run them before any release that touches `core/`: they compare builds byte for byte with recorded ones.
  `golden-builds.test.ts` is the widest of them: for each of the nine official files, some twenty recipes that
  between them use every feature, with the SHA-256 of every file built (`golden-builds.json`). It takes about
  fifteen minutes with all nine files.
- `ui/test`: the store with the platform mocked (`store-gr3.test.mjs`), the Android updater, the texts (both
  languages have the same entries and variables), the release list against the engine, and that every part of
  the store and every page loads.
- `shell`: unit tests per package, and `smoke.sh` against the running development build.

## On GitHub

| Workflow | When | What |
| --- | --- | --- |
| `test.yml` | every push to `main` / `ios`, every pull request | the checks above, without the firmware files |
| `ios.yml` | every push to `ios` | compiles the iOS app; with the App Store Connect secrets, signs it and uploads it to TestFlight |
| `packages.yml` | by hand, or a tag `vX.Y.Z` | builds the Windows program, the Mac bundle and the Android app as artifacts ([releasing](releasing.md)) |
