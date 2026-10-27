# GR Mod

A small desktop tool for the Ricoh GR IV / GR IV HDF / GR IV Monochrome (firmware 1.11), the GR III /
GR III HDF (firmware 2.10) and the GR IIIx / GR IIIx HDF (firmware 1.60). Not a Ricoh product.

0.8.6: on the GR IV, MENU works again in the Flash submenu after coming back from Direct Flash Settings (the firmware keeps a nested submenu's back target only for its own nested submenus; `installNestedBack` in `core/src/fw/aspect/directflash-menu.ts` adds Direct Flash Settings to both checks); the What's New dialog names the code contributors; GR III / IIIx films get a remove button each, as GR IV's added slots (`removeFilm` in `ui/src/store.ts`). GR IV's added slots also get hue sectors of their own: Standard's multi-axis stage (12 hue sectors, YCbCr hue, `core/src/color/hue.ts`) is fitted per slot as well (`hue-fit.ts`, from the LUTSmith parametrisation that PR #8 / #15 brought in) and written as the slot's own block; each .cube or .xmp is fitted both with and without it and the sectors are kept only when the whole look gets at least 2% closer while greys, near-neutrals and skin get at most a little worse (`huePasses` in `convert.ts`; an .xmp is checked on the third of the calibration colours its fit leaves out). Checked on a GR IV as test firmware 064 (camera vs model 0.5–0.8 dE00).

0.8.5: one program for GR IV and GR III / IIIx. GR IV gets Direct Flash (a fifth Flash Mode: fixed
power, exposure from the focus distance and the guide number; GN, background down to -5.0 EV,
minimum and maximum shutter speed and exposure priority Standard / Max Sync in the camera's Flash
menu; the exposure compensation applies to the flash too; `core/src/fw/aspect/directflash*.ts`,
`tools/directflash`; as test firmware 062 with the sync limit as the default maximum, built on
057's camera test). GR III / IIIx builds are round 10 by
default (GR IV's ways, below; camera-tested); `gr3Round: 9` rebuilds round 9's files. The standard
GR III / GR IIIx are models of their own beside the HDF ones (the same official files: Ricoh's 2.10
/ 1.60 archives apply to every edition). Each camera's official file is kept once downloaded or
opened (`firmware-gr4.bin`, `firmware-gr3.bin`, `firmware-gr3x.bin` in the data folder; 0.8.x's
single `firmware.bin` moves to its camera's place), so switching cameras opens it again without a
download. GR III / IIIx pages and texts are GR IV's but for what the cameras do differently; no
ratios or films are added until the user adds them.

## GR III and GR IIIx

One program for both families: GR IV files are built exactly as by GR Mod 0.8.4 (GR IV's code is
shared and unchanged; `core/test/gr4-unchanged.test.ts` pins its outputs), and the GR III / IIIx code
(`core/src/fw/gr3x`, `tools/gr3x`) is used only for the exact official GR III 2.10 / IIIx 1.60
files; both get every GR III feature (GR III 2.10 is the IIIx 1.60 program, and
`core/test/gr3-equivalence.test.ts` builds every feature for both and compares them byte for byte
but for the identity bytes). Each family keeps its own work: GR IV's in `project.json` as before, GR III / IIIx's in
`project-gr3.json` with its presets `gr3-preset-…` (`ui/src/store.ts`). The GR III test builds
(0.8.0-gr3exp.1 .. 0.8.4-gr3exp.1) kept a data folder of their own (`GRMod-GR3-Experimental`); a
release takes its GR III work over once (`shell/migrate.go`). A version containing `exp` is still a
test build: own data folder, no updates.

GR III 2.10 (`fwdc239b.bin`) and GR IIIx 1.60 (`fwdc243b.bin`) are the same build of one program:
every address is shared and the images differ only in identity bytes (name, project/product,
version, build time, RTC epoch year). The IIIx port is therefore applied unchanged to GR III;
`core/test/gr3-equivalence.test.ts` checks that every GR III build is the IIIx build of the same
recipe with only the identity bytes swapped, and the native probes in `tools/gr3x` run on either
RTOS. Newer releases (GR III 2.20, GR IIIx 1.70) are a different program and are not supported;
the shell downloads the pinned 2.10 / 1.60 archives.

On a GR III (rounds 1..6, by the owner): custom ratio lists with full-frame RAW, up to 20 films
(looks 64..83) with their own parameters and a second matrix, soft focus on the ADJ lever, the
date imprint (GR IV's submenu), End Screen pictures (GR IV's Type / Picture submenu) and halation.
Round 7 follows GR IV 0.8.2 (`core/src/fw/gr3x/guard.ts`, `halation-rows.ts`, `tools/gr3x/native/slots3.c`):
a settings guard (unknown looks and ratios back to factory at load, save and mode recall), 0.8.2's
halation with three strengths and red / white set in the camera (GR III's parameter screen has no
Fn submenu, so a film gets two rows: Halation built as GR III's own Grain Effect, Off / 1 / 2 / 3,
and Colour), preset fingerprints (a film whose preset changed starts again from neutral), and the
date imprint light only for black-and-white looks. Files of earlier rounds are still rebuilt byte
for byte (`guard: false`, the recipe has no `round`).
Round 8 (the default; `gr3Round: 7` builds round 7) follows GR IV 0.8.4: the date imprint follows the
camera's orientation at the start of the exposure (the direction GR III writes to EXIF, read at
SetShootingInfoResultBeforeExpose; a third submenu line Follow Orientation, default On), Style has the
four values with the look's English name (the camera's own names for looks 11..22, the build's for
films), the Style labels as wide as the row allows (GR IV test 052), and the Image Control order and
hidden looks (`core/src/fw/gr3x/look-layout.ts`: ImageControlModel's count, entry and reverse lookup
answer from the layout for the still / ADJ, movie and RAW development lists, and RAW development's
dial takes the list's length instead of its own fixed twelve (0x53283c08); a hidden look in use becomes
Standard, a hidden film keeps its parameters, `native/slots3.c -DHIDDEN_FILMS`). Halation is 光晕 in
Chinese again (GR III's fonts are GR IV's and have the glyph). The orientation byte and the frame's
look share the End Screen mode word's upper bytes (0x5580437d, 0x5580437e). #7's fitting is used for
films. Round 9 (the default; `gr3Round: 8` builds round 8): the live view's change detection
(0x536dc860) reads the look itself at 0x536dc998 instead of a film's native base, so changing from one
film to another (or Standard to a film) computes the matrix, second matrix and curves again; up to
round 8 the live view kept the previous film's colour until a parameter changed
(`tools/gr3x/live_refresh_probe.py` runs it).
Round 10 (experimental, `gr3Round: 10`; the default stays round 9; recipe `round: 10`, revision T10)
does GR Mod's additions the GR IV way wherever GR III has the same structures; colour fitting and the
Image Control order / hidden looks keep GR III's implementation (`core/src/fw/gr3x/round10.ts`,
`films-r10.ts`, `native/films.c`). The films are looks of their own: the tone, multi-axis and YCbCr
descriptor tables grow to 84 entries and film k is look 64 + k everywhere (four rendering decisions
and the shooting-mode restriction still take it as Standard). They borrow Bleach Bypass's parameters
(Standard's nine and Toning, in every photo and movie set) and keep their Halation in that Toning
byte as GR IV's twelve states; the values of the looks not in use wait in HTData record 12 ('GR3A',
version 10; rounds 6..9's tables are taken over at the first start). The films are in the movie list
too; RAW development, the maker note (ImageTone 0x8110 + k, Toning 0x100 + state) and playback know
them. ADJ soft focus is function 0x09 (after Image Control, as GR IV's 0x0A; rounds 6..9's 0x13 in
the ADJ slots becomes 0x09 at start). The start-up zero fill clears 76 bytes up to the heap's first
block (0x558043c0): one RAM word per addition, as GR IV. The settings load and save go through GR IV's
scaffold (the guard, the films and the End Screen hook it); the End Screen choice is its own HTData
record (13). What stays different: RAW development shows Standard's parameter lines for a film (its
Halation is applied as shot), the playback parameter page shows Standard's, the date imprint's
setting byte stays in the record, the curves and the second matrix stay hooks (GR III applies
saturation before the curves). Probes: `films_r10_verify.py`, `films_probe.py`, and round 10 branches
of the soft focus, guard, End Screen, layout, halation rows, picture stage and date imprint probes.
Black-and-white and toned black-and-white presets
(output colour a function of brightness only) are fitted with equal matrix rows and a curve per
channel, no second matrix (`isTonedMonochrome`, `fitTonedMonochrome` in `core/src/color/gr3x-import.ts`):
they stay neutral (or toned) at any saturation setting. Round 8 probes: `look_layout_probe.py`, `datestamp8_probe.py` (orientation, names, RAW
development, and every picture case against GR IV's 0.8.4 module), `list_width_probe.py`. Added ratios narrower than 1:1 stay allowed
on GR III (3:4 was tested there); GR IV refuses them from 0.8.2. The GR IV Monochrome looks are
not ported.
Camera test procedure: [docs/GR3_HDF_210_TEST.txt](docs/GR3_HDF_210_TEST.txt); IIIx details: [docs/GR3X_HDF.md](docs/GR3X_HDF.md).

- `core/`  platform-independent TypeScript: firmware container codec and patcher with built-in self-check (`src/fw`), added aspect ratios (`src/fw/aspect`), preset conversion from .xmp Look profiles and .cube LUTs (`src/color`), exact-length baseline JPEG encoder (`src/jpeg`), start-up script generator and simulator (`src/wallpaper`; used by GR Mod 0.7 and earlier, whose power-off images rotated through a start-up script on the card; 0.8 builds them into the firmware and the UI no longer offers the script), memory-card layout planning (`src/card`), and the `Engine` facade (`src/app`).
- `ui/`    React UI (Vite). Talks to the platform through `src/host.ts` only.
- `shell/` desktop shell in Go for Windows, macOS and Linux (a WebView2 window on Windows, a Chromium "app" window on macOS and Linux, plus a local HTTP API for drives and files, and for fetching the official firmware from Ricoh's site and updates of GR Mod itself). See `shell/README.md`.

Build: `npm install && npm -w ui run build && (cd shell && ./build.sh windows)` → `shell/dist/GRMod.exe`; `./build.sh mac` → `shell/dist/GR Mod.app` and `shell/dist/GRMod-mac.zip` (Intel Macs with macOS 10.13 or later, Apple silicon with macOS 11 or later), plus `GRMod-<version>-mac.dmg` when the disk image tools are installed; `./build.sh linux` → `shell/dist/grmod` (x64).

On a Mac: unzip `GRMod-mac.zip` and move `GR Mod.app` to Applications. The app is signed ad hoc, not with an Apple Developer ID, so the first start is blocked: open System Settings › Privacy & Security and click "Open Anyway" (or run `xattr -dr com.apple.quarantine "/Applications/GR Mod.app"` once). The UI opens in a window of Chrome, Edge, Brave, Chromium or Vivaldi when one is installed, otherwise in the default browser; GR Mod quits by itself about 20 seconds after that window is closed. macOS asks once for access to removable volumes; allow it, or the card cannot be written.

On Linux: start `shell/dist/grmod`. The UI opens in an app window of Chrome, Chromium, Edge, Brave or Vivaldi when one is in `PATH`, otherwise in the default browser; GR Mod quits when that window is closed. The card is offered once the desktop has mounted it (as the file manager does, below `/run/media/<user>` or `/media/<user>`), and Eject unmounts it with `udisksctl`. The folder dialog needs `kdialog` or `zenity`. There is no Linux release package, so this build does not update itself.
Test: `npm -w core test` (the byte-identity tests need the official firmware in `core/testdata/private/`, which is not distributed), `cd shell && go test ./... && go test -tags desktop ./...`.

An Android build would reuse `core/` and `ui/` unchanged and replace `shell/` with a WebView wrapper implementing the same host interface (volumes via the Storage Access Framework).

No firmware file is included here. The user picks the official 1.11 file, or lets the program fetch it: the shell reads Ricoh's own download pages for the chosen model and downloads the current update from there, or, when that is not 1.11, the 1.11 archive that is still on Ricoh's site at a fixed address, checked against its SHA-256 (`shell/internal/ricoh`; Ricoh's page says that downloading means accepting its software licence agreement, and the dialog says so too and links to it). The before/after preview and the frame of an added aspect ratio are drawn on a sample picture, `ui/src/assets/preview.jpg`: DPReview's studio test scene, included with DPReview's permission (it is not covered by the licences of the code). The user can replace it in the UI, or by keeping a `preview.jpg` next to the program (on macOS: next to `GR Mod.app`; served by `GET /api/sidecar/preview.jpg`). `core/src/color/data.ts` holds measurements (the camera's base tone curve and paired calibration colours). The power-off image method builds on the public research in radium-wang/ricoh-gr4-firmware-analysis-and-feature-expansion.

## Added aspect ratios

`core/src/fw/aspect` adds aspect ratios to the camera next to the four factory ones (up to 8; e.g. 65:24 gives 6192×2272 JPEGs). It is a TypeScript port of the crop compiler of [DoYitNow/gr-custom-tool](https://github.com/DoYitNow/gr-custom-tool) and is checked against it: `core/test/aspect-oracle.test.ts` builds 439 configurations (every possible screen geometry, and random lists of up to 8 ratios) and compares them byte for byte with what the reference produced (`tools/aspect/gen_oracle.py`). From 0.8.2 an added ratio must be wider than tall (A:B with A > B; upright pictures are taken with the camera turned): with a ratio narrower than 1:1 the live view showed lines of an old picture beside the picture on the camera (tests 036..040), which no repaint cured. Files of earlier versions with such ratios are still read back. `tools/aspect/verify_file.py FILE --boot` runs the firmware's own functions of a built file in an emulator. The RTOS and ICONBIN sections of such a file are longer than the official ones; the version stays 1.11.

One thing is added on top of the port (build revision 2, `installPlaybackDecode` in `build.ts`; the end of the RTOS section says `GRMODAR2`, files of GR Mod 0.2.x say `GRMODAR1` and are still recognised). Magnifying a photo in playback decodes the whole JPEG into a buffer the firmware sizes for `align16(width) × height` rows while its decoder asks for `align8(height)`; every factory size has a height that is a multiple of 8, the sizes of added ratios are multiples of 4, and for those the decode step gave up and the playback screen stayed in its magnifying state. The byte count of that allocation is now taken for the height rounded up to 8. `tools/aspect/playback_check.py FILE` runs the firmware's own image creation for every photo size on the official firmware and on FILE.

On a camera: a user reports that a 0.2.x build installs and shoots in the added ratios, and that magnifying such photos got stuck (the reason for revision 2). With revision 2 the user reports that magnifying 65:24 photos works. See `third_party/gr-custom-tool/NOTICE.md` for what is derived from the reference.

## Soft focus

Two generations:

- GR Mod 0.4.x (`core/src/fw/clarity.ts`) rewrote rows of the camera's clarity table (RTOS 0x53b4c860, 9 rows for clarity −4…+4 of 11 int16 gains in Q10, finest band first) so that clarity −2 / −3 / −4 became weak / medium / strong soft focus. Such files are still recognised and verified; the program no longer writes them.
- GR Mod 0.5.2 (`core/src/fw/aspect/softfocus.ts`) puts soft focus on the ADJ lever with four values (off / weak / medium / strong) and leaves the clarity table official. The ADJ controller is table-driven (21 records of member-function pointers at 0x53d9f714, addressed from 23 places). Soft focus takes over function 0x0A (Flash Exposure Comp.), which the GR IV never offers on the ADJ lever (not in the ADJ mode setting list, not in the fixed layout of any camera mode); its record is overwritten in place with Crop's, carrying four new handlers, so the table does not move. The ADJ mode setting list gets 0x0A after Image Control; its name is text 840 in all 21 languages and its icon is icon 720 (bounds never above what added ratios use). The value is kept in byte 0x90F of the user settings, alignment padding that the factory-defaults initialiser never writes; the structure is saved, loaded and copied to U1–U3 as a whole, so the value survives power-off. Whether a picture goes through the digital-filter step at all (0x537150fc) depends on Clarity being non-neutral for most image controls; while soft focus is on it counts as non-neutral. DigitalFilterProcess::SetEffectParameter passes clarity 5 / 6 / 7 while soft focus is on, and the clarity function takes rows 9–11 from a table of the three soft-focus rows. It acts on the recorded picture only: live view does not go through this step. The five ADJ slot getters read a function above 0x14 as off. Built files are revision 3 (`GRMODAR3`): the record at the end of RTOS may list no ratio and carries one more byte for these additions. `tools/softfocus/check.py RTOS.bin official-RTOS.bin` runs the patched functions in an emulator.
- GR Mod 0.5.0 / 0.5.1 used function 0x15 and copied the table to the appended area, moving 22 of its 23 references; the one left (0x531bd0f0, a check over the five slots when ADJ is pressed) read past the official table once 0x15 was on a slot, and the camera froze. A camera that still holds 0x15 in a slot has it read as off from 0.5.2 on; the official firmware would freeze, so take soft focus off the ADJ slots before going back to it.

Clarity is a Laplacian pyramid on the developed picture (RetouchService, 0x538a1fa8): the function copies the table to the stack, returns at once for clarity 0, takes row `clarity + 4` and multiplies each band of detail by its gain through the first diagonal entry of a CSC matrix (the other entries stay 1.0, so luma only, by inference). Lower gains on the fine and middle bands with the coarse ones kept give roughly `g × picture + (1 − g) × strongly blurred picture`, the usual digital soft focus. `core/src/color/clarity.ts` is a model of the pyramid (bilinear scaling assumed). It is linear and works after gamma on the 8-bit picture, so highlights do not bloom. Tried on a camera with 0.5.2: the three strengths are clearly distinct on the recorded picture.

## Date imprint

`core/src/fw/aspect/datestamp.ts` hooks JpegEncodeMacroProcess::Execute (0x537034b4) and runs the position-independent C module `tools/datestamp/datestamp.c` (compiled by `tools/datestamp/gen.py`; `GRMOD_ZIG=1` uses `python3 -m ziglang cc`, the compiler of the committed bytes) on every picture the JPEG encoder is given: main picture, 720x480 screennail, 160x120 thumbnail. It draws the date bottom right (pictures anywhere in 0x40000000..0xBFFFFFFF: with RAW+JPEG the scaled main picture of the smaller JPEG sizes is above 0xA0000000) in orange seven-segment digits, `'26 10 08` or `2026.10.08 17:34`, light only on black-and-white photos. The setting is byte 0x94B of the user settings (padding the factory-defaults initialiser never writes, like 0x90F for soft focus): bit 0 on, bit 1 the long style, bit 2 Follow Orientation off (0.8.3), bit 3 the look's name (0.8.4), anything above 15 is off.

Look name (0.8.4; the idea of PR #9 by jaylee / sjclijie): Style has four values, `'26 10 08`, `2026.10.08 17:34` and each followed by the name of the picture's look (setting bit 3; texts 880 / 881, icons 731 / 732). The name is the one the camera's English menu shows (an added slot's own name; Cinema Yellow / Green as GR Mod renamed them: the English name, else one given in Chinese, Japanese, Korean, Russian, Greek or Thai if it is plain ASCII), drawn after two spaces in fourteen-segment capitals with the digits' bars, colour, height and spacing (letters 13/16 of the height wide; digits in a name stay seven-segment; characters without a segment shape become a space; at most 24). The build turns the names into glyphs, a table per look (`lookNames`, `lookNameGlyphs`). The look is the one at the start of the exposure: the exposure hook copies the development step's look word into FRAME_LOOK (0x558372F8), and in RAW development the step writes it from the developed record, so a look chosen while a picture is being processed does not change its name. The line is drawn only where it fits with a margin on either side: at the date's height, else smaller (down to 3/4), else with the name cut short; failing that, the date alone. The thumbnail gets the date alone. Drawing (0.8.4) only looks at the pixels of each row inside a bar's box: the date costs about a third of the instructions it did (L 3:2, all three pictures: short 12 M, long 23 M instead of 41 M / 81 M), with the name 39..64 M; the date's pixels are unchanged. A 0.8.3 firmware that finds bit 3 set draws nothing and its menu shows (and stores) Off. `tools/datestamp/name_check.py` checks it in the emulator.

Orientation (0.8.3): with Follow Orientation on, the imprint sits in the bottom-right corner of the picture as it is viewed upright (EXIF Orientation 6, 8, 3), its digits turned to read normally, on all three pictures. The direction is the camera's at the start of the exposure (`SetShootingInfoResultBeforeExpose`, 0x53628CD8: the live shooting record's byte 0xD8, the value the EXIF writer later maps to 8 / 3 / 6), kept in a word for the module; the development step at 0x539113F8 runs for live view as well and does not see it. In-camera RAW development takes it from the record the EXIF writer reads.

`core/src/fw/aspect/datestamp-menu.ts` puts it in the camera menu: a line after Horizon Correction on the Shooting Assist page of the still menu, opening a submenu (On/Off, Style, Follow Orientation; laid out like Instant Review's 3-line submenu), each line a list built like Horizon Correction's. The three items are bits 0..3 of one settings byte (+0x94B; Style is bits 1 and 3; bit 2 set means Follow Orientation off, so older bytes read as on). The still menu already has the maximum of 38 lines, so two descriptors are appended, one without Red Filter (GR IV Monochrome only) and one without HDF (GR IV HDF only), and the menu builder picks the one for the camera's model; every model sees the official menu plus the new line. The submenu and list record tables are relocated with the new records (including the end pointer the list constructor scans to, 0x531d6dac). Texts 841..845, 879..881, icons 721/722, 731/732. The list rows (SelectMenuController's class 0x5357AB24) give a value's text a 400 px label (x 100..500), too narrow for the longest Style values; after drawing a Style value the label is made as wide as the row allows (to 20 px before its right edge, never beyond x 680, through the label's own SetRect), only for that list and only for rows and labels of the expected classes (`tools/datestamp/list_width_check.py` runs the list's own code on rows built by their constructor and compares with a build without it; other lists stay byte for byte the same). `tools/datestamp/menu_check.py BUILT-RTOS OFFICIAL-RTOS` runs the patched firmware functions in an emulator (menu builder for all three models, controller factory, SetCurrentMenu, the handlers for every value of the byte, the controllers drawing the new records, the list constructor's table scan, texts and icons); `tools/datestamp/render_check.py` runs the module on synthetic pictures.

## Monochrome looks

`core/src/fw/aspect/monounlock.ts` makes the six looks of the GR IV Monochrome selectable on the colour models, after [lemonadesaltbagel/GR4-MonoUnlock](https://github.com/lemonadesaltbagel/GR4-MonoUnlock) (no code copied): the check at 0x533cc6e0 becomes `cmp r1, #0x18` / `bhi`, and rows 3..8 of the look availability table at 0x53dbf36c (7 bytes per row, one column per camera model, column 1 = Monochrome) get every column except 1. The reference sets column 0 only (the standard GR IV); with every colour column the GR IV HDF has them too. 13 words in all.

## Direct Flash

`core/src/fw/aspect/directflash.ts` (0.8.4, with tests 053..061) adds "Direct Flash" (直闪模式) as the last value of the camera's Flash Mode (menu lists, ADJ lever, Fn list): the flash fires at a fixed power and the exposure is planned from the subject distance and the flash's guide number, f-number = GN x sqrt(ISO / 100) / distance, the way the GR III's GF-2 Flash Mode behaves (independent work: found in the official 1.11 firmware, no code of GR4-GF2Unlock or of the GR III). In P, Tv, Av and M; not in bulb / time, Snap Distance Priority, movies, or with a flash that communicates (P-TTL). Flash and ambient light are planned together: the subject's exposure is the flash plus the ambient light, the background (ambient light only) is the chosen Background Brightness below a correct exposure; f/2.8..f/16, the ISO within the user's range (ISO Auto) or fixed, the shutter between the chosen slowest speed and the camera's own flash-sync limit (0x536792E0, which depends on the aperture); Flash Output 1/4 and the ND filter count two stops each, ND Auto puts the ND in only when it helps. Too bright even at f/16 and the lowest ISO, the shutter goes faster, to a correct exposure of the subject where the ambient light's share allows, but no more than 2 EV past the background chosen (test 062: no jump to the sync limit where the flash alone is too bright). Maximum Shutter Speed (test 062; byte 0x109 of the user settings, padding between a byte at 0x108 and a word at 0x10C that the factory-defaults initialiser never writes, inside the 0xAE9 bytes the settings save keeps): the camera's sync limit (the default), 1/2000, 1/1000, 1/500 or 1/250 s, for flashes that at full power burn longer than a fast shutter is open (a Godox iT32 at full power, about 1/1000 s, came out about 3 EV dark at 1/4000 s; the GF-2 burns short enough). The camera's exposure compensation (its own value, read as the camera reads it for the ambient light: +0x108 of the exposure record, plus +0xE4 when +0xFC is 0, within +-8 EV) applies to the flash as well, so the subject and the background change together.

Exposure Priority: Standard (the background as chosen; where the sync limit holds the shutter back, a smaller aperture and a higher ISO for a faster limit) or Max Sync (the shutter at the sync limit wherever the subject can still be correctly exposed; the background as dark as that makes it).

The choice is not a new Flash Mode value: Direct Flash is Flash Mode 0 (Flash On) plus bit 0 of byte 0x99B of the user settings (padding the factory-defaults initialiser never writes), so the rest of the firmware only ever sees 0..3. The exposure: the still exposure's call of the flash program (0x5367A7B4, at 0x5367AAA8) goes through a wrapper that then runs the module `tools/directflash/directflash.c` (hard-float, position independent, compiled by `tools/directflash/gen.py`), which replaces Tv / Av / Sv (+0xD0 / +0xD4 / +0xD8 of the exposure record) and the ND decision (+0x560) before the flash data is prepared. The settings are chosen in the camera, not in GR Mod: the Flash submenu gets a "Direct Flash Settings" line that opens a submenu (`core/src/fw/aspect/directflash-menu.ts`) with Guide Number (GN 2..36, 21 values; byte 0x99A bits 0..5), Background Brightness (-0.3..-5.0 EV in thirds; 0x99B bits 1..4), Minimum Shutter Speed (1/125..1"; 0x99B bits 5..7), Exposure Priority (0x99A bits 6..7: 2 Max Sync, else Standard) and Maximum Shutter Speed (0x109 bits 0..2: 0 the sync limit, 1..4 1/2000..1/250). `tools/directflash/check.py BUILT OFFICIAL` runs the module in an emulator against a Python version of the rule (every guide number with both priorities, exposure compensation; 200000+ situations), the menu handlers and the icons; `tools/directflash/settings_check.py` checks every list and byte value. `tools/testfw/extend.ts` rebuilds a verified test firmware with more additions (e.g. test 053 = 052 + Direct Flash).

## Second matrix

Every imported preset (.cube / .xmp) is fitted as a colour matrix, three tone curves and a post-curve ("second") matrix (`core/src/color/fit.ts`): the plain fit first, then all three together on the same CIE76 objective. The camera applies the second matrix after the tone curves, together with the saturation setting; each slot gets its nine saturation matrices multiplied by it (Q9 rows of 512), so the saturation setting keeps working. On nine test presets the mean error drops on all of them (e.g. Provia 100F ΔE2000 1.32 → 0.43).

## Added Image Control slots

`core/src/fw/aspect/slots.ts` adds up to twenty looks (styles 34..53; six up to 0.8.1) after Cinema (Green), each with its own matrix, curves, second matrix, ASCII name (texts 846..851, then 864..877) and icon (768..779, then 782..789). A new look's records are complete copies of Cinema Yellow's with its own colour data and Standard's multi-axis blocks; the four style tables are copied with the new styles appended to each camera variant's row, and everything else that knows the style numbers (menu order and counts, names, icons, the ADJ list's own icon lookup, the shooting overlay, RAW development, look visibility, the live-view parameter generator) is extended. Tried on a GR IV HDF as test firmwares 022..034 (022 copied incomplete multi-axis records and the camera stopped on the first ADJ highlight of a new slot). Since 0.7.1 in-camera RAW development keeps an added look's parameters in Cinema Yellow's row of its own parameter table (with the look's own row, row 0, every parameter was "absent": the screen showed -4 and developing stopped the camera); as in the settings, that row has one owner per custom base and the module keeps the other looks' values, so every added look starts from its own saved values and keeps its own changes; and pictures name the added look in the maker note (ImageTone 0x8110, 0x8111, ...; before, Standard) with Cinema Yellow's parameters, which playback and RAW development read back: the playback information shows the slot's icon and parameters.

Halation (`core/src/fw/aspect/halation.ts`, module `tools/halation/halation.c`, camera screens `core/src/fw/aspect/halation-ui.ts`): the light of the highlights spread around them, either red (CineStill 800T: cinema film without its anti-halation layer) or white (a soft bloom in each light's own colour, like the GR IV HDF's highlight diffusion). Every added slot has it; Cinema Yellow / Green only with a preset and when GR Mod is asked to. In the camera (0.8.2) the look's Toning row (parameter 8, which does nothing for these looks) becomes a "Halation" row built like Grain Effect's: an Off / On slider, and Fn opens Grain Effect's own submenu with the halation's title and two rows, Strength (Weak / Medium / Strong) and Colour (red / white); the same on the in-camera RAW development screens. Off / on, strength and colour are encoded in the Toning byte (0..11; 0, 1, 2 keep their earlier meaning: off, weak red, strong red), which travels with the settings, U1–U3, the picture's record, RAW development and the maker note (3..11 are written as codes 4..12 and read back); the native readers that hand it to the image engine see 0..2 only. The development step that reads the frame's record (0x539113DC) leaves the style and the decoded level and colour in a word; the module runs at the start of JpegEncodeMacroProcess::Execute (before the date imprint) on every picture of the frame: light through the look's own table (the value taken back through the look to linear light; it starts softly, with the square of the light above a start), averaged down to at most 1024 px, spread twice (a narrow fringe and a wider glow, three box passes each, relative to the width), then a table lifts red, green and blue towards white (red: red first; white: three maps, each channel by its own). Gains 12 / 18 / 24. GR Mod's preview runs the same integer computation (`halateYcc`), bit for bit; the module was checked against it in an emulator. Live view does not show it; RAW files are not changed.

Adjustable parameters: the firmware keeps them per factory style, and whatever reads them for the selected look takes the new styles as Cinema Yellow (18). Each new look still has its own values, kept per photo/movie set and across power-off: Cinema Yellow's fields hold the values of the look selected in a set, the other looks' values wait in a table of a native module (`tools/slotparams/slot_params.c`, pre-compiled per slot count by `gen_slotparams.py` into `slotparams-native.ts`) saved as its own record (HTData 12) after the settings. The module takes over the 13 getters and setters of Cinema Yellow's parameters and the 8 "style of set" setters, and chains to the settings load/save. The 88 change functors of those fields (which give the value to the camera model behind the parameter screen), the parameter screens' list choice (grain), the main menu's Image Control row and the digital-filter step (grain, Clarity) take the new looks as Cinema Yellow as well. New looks start at the neutral values, which the parameter screen also shows as their defaults. The table keeps a fingerprint of each slot's preset (0.8.2): a slot whose preset changed starts again from the neutral values, in every set and in U1–U3; the other slots keep theirs. U1–U3 share the table; a settings reset does not reset it.

## Settings guard

`core/src/fw/aspect/guard.ts` (every build from 0.8.2): when the settings are loaded (start), saved (power off) and when U1–U3 are recalled, values this firmware does not know go back to factory ones: a look that is not an installed added slot becomes Standard, a ratio that is not in the menu 3:2, soft focus on an ADJ slot without the feature off. Such values stay in the camera after a firmware with more additions was written; the firmware then looked them up past its tables, and the camera could freeze.

## Image Control menu order and hidden looks

`core/src/fw/aspect/looks.ts` lets the user reorder the Image Control menu and hide looks they do
not use. It does not add code: the menu order is a 20-byte table at `0x53DBE388` (one byte per
style, 11..30), and hiding a look redirects its entry in the visibility jump table
(`0x533CC6F8` for styles 11..24, `0x533CC648` for the monochrome looks 25..30) to the
firmware's existing `mov r0, #0 ; bx lr` stub at `0x533CC748` / `0x533CC670`. The menu builder
`0x533CC78C` walks the table in order and skips hidden looks, so the list capacity and every
count constant stay unchanged.

The UI puts the order/hide card on the Image Control page: rows can be dragged or moved with the
arrows, the eye toggles a look, Standard (style 11, and 25 for the monochrome looks) cannot be hidden, and "reset" restores the
factory order. The order is saved in `project.json` (`lookOrder`, `lookHidden`). Added slots
(styles 34..53) participate in the order; hiding an added slot uses the slot visibility hook that
`slots.ts` already installs.

- Without added slots or other additions the file keeps the official layout: only the order table
  and the visibility words change (in place, like the monochrome looks).
- With added slots, ratios, date imprint, etc. the grown layout is used; the order table points to
  a new array holding the factory looks and the added slots in the chosen order.
- `validateLookLayout` refuses an incomplete order, duplicates, hiding every look and hiding
  Standard. The order table itself was verified on a camera: order `[12,11,...]` shows Vivid then
  Standard, and `[17,18,11,...]` shows Positive Film, Cinema Yellow, Standard.
- A look that is hidden is also absent from the ADJ list and RAW development's list (both lists are
  built through the same visibility check). If the camera's settings select a look that is now
  hidden (the standard photo or movie set, also in U1–U3), the settings guard turns it into Standard
  when the settings are loaded, saved or recalled (11, or 25, the monochrome looks' Standard, for
  25..30; neither can be hidden). Custom sets keep their look. The layout is recorded in the file,
  so the program recognises and verifies it (`tools/looks/looks_check.py` runs both lists and the
  guard in an emulator).

## Power-off pictures chosen in the camera

`core/src/fw/aspect/shutdown.ts` (camera side: `tools/shutdown/shutdown.c`, compiled by `tools/shutdown/gen.py`) builds 1 to 8 pictures into the firmware and lets the camera choose among them: Setup > Display > End Screen opens a submenu with Type (the camera's own type 1 / 2 list, unchanged) and Picture, a list of the factory picture of this camera and the pictures by name, each with a 520x200 thumbnail above the list. `tools/shutdown/menu_check.py` runs the menu in an emulator. The approach follows gr-custom-tool's End Screen list (Copyright (C) 2026 DoYitNow, GPL-2.0-only); the code is GR Mod's own.

- The pictures are files of the RES section, `A:\Resource\Jpeg\GRMOD<k>.jpg`, inserted after `SymKey.jpg`; the firmware update writes them to the camera's A: drive. Each is a 720x480 baseline JPEG of exactly 2 x 0x6000 - 36 bytes (highest standard quality that fits, padded with comment segments), so that RES grows by whole container frames (`growPayload`, `buildGrown`; the self-check and `inspect` accept one run of inserted RES files).
- The table of full-screen JPEGs (0x55013E70, 12 entries) is copied with one entry per picture (numbers 12, ...) for both of its readers; the power-off picture request (0x531B9488) asks for the chosen number, or runs as before.
- The choice is a record of the camera's settings store APData (record 74, created for 75 records instead of 16 at 0x53A80ADC): `{'MSDO', identity}`, written when a row is confirmed and again at every settings save. A missing or foreign record, or one naming a picture that is no longer listed, means the factory picture.
- The menu's controller: the constructor builds 3 + n rows from an appended array of row types; refresh, confirm, up / down and footer go through the module. Names are texts 853.. (853: the factory row, "Original" / オリジナル / 原廠 / 原厂), thumbnails icons 992...

Checked in an emulator on built files (1, 2 and 8 pictures, alone and with every other addition): the picture request for every camera variant and record state, the constructor, ticks, labels, confirm, up / down at the ends, thumbnails, the store's record count and the settings save chain.

## Updates

The program can update itself (`shell/internal/update`, UI in `ui/src/updates.tsx`). At start (switchable off in the dialog) and from "Check for updates" in the ? menu it reads `update.json` and `update.json.sig` from the release tagged `fw1.11` (the line for camera firmware 1.11, whose files every 0.8.x release replaces), then from `https://github.com/Maxwooow/Ricoh-GRMod/releases/latest/download/`; a version 0.9 or later there (for camera firmware 1.20, which a camera cannot go back from) is only reported, never installed (`GRMOD_UPDATE_SOURCE` replaces these addresses for tests). The manifest is accepted only if its Ed25519 signature verifies with the public key in `shell/updates.go`; the package (Windows: `GRMod-x.y.z.exe`, macOS: `GRMod-x.y.z-mac.zip`) only if its size and SHA-256 match the manifest. Windows renames the running `GRMod.exe` to `GRMod.exe.old` and puts the new one in its place; macOS moves the running `GR Mod.app` to `.GR Mod.app.old` and the unpacked new bundle into its place. The shell then closes its window, starts the new program with `--after-update=PID`, which waits for the old one to end and removes the `.old` copy. An app that macOS runs translocated (never moved out of the download folder) or a folder that cannot be written is not replaced; the dialog offers the download page instead.

Publishing a release: build, then

    go run ./tools/updatesign -key PRIVATE.key -version X.Y.Z -notes-zh "…" -notes-en "…" \
        -windows dist/GRMod.exe -mac dist/GRMod-mac.zip -out dist/release

(in `shell/`) and upload everything in `dist/release` (plus the .dmg for new users) to the GitHub release `vX.Y.Z`, which must be the latest release, and the same four files to the release `fw1.11` (replacing its files). The private key is not in the repository.

## The UI

The Image Control page has one card of switches under the two slots: soft focus (ADJ lever), date imprint (with its menu) and monochrome looks (not shown for the Monochrome model). They are saved with the project (`soft`, `dateStamp`, `monoUnlock` in `project.json`) and passed to `Engine.buildFirmware`; the firmware copies page reads them back from a file through `Engine.inspect`.

Going back to the factory firmware ("Write factory firmware" on the Image Control page, or an official copy on the firmware copies page) asks first, in red, whether the camera's settings were reset (Setup › Reset › Reset to Factory Default): settings made with GR Mod's firmware (an added slot or ratio selected, soft focus on the ADJ lever, the date imprint) are values the official firmware does not know. Cancel has the focus; only the red button writes.

## Combinations

Anything that appends code or icons (ratios, ADJ soft focus, date imprint) gives the grown layout: RTOS grows, and ICONBIN too when icons are added (a build that only appends code, like the date imprint of a test build with a fixed setting, leaves ICONBIN as it is; `growPayload`, `grownRanges`, `Engine.inspect` and the self-check accept either). The monochrome looks (`core/src/fw/aspect/monounlock.ts`, 13 words) on their own are written in place, like Image Control edits: official layout plus the checksum compensation word; `Engine.inspect` recognises them when all 13 words are there. With any of the other additions they go into the grown build and its feature byte (bit 2). `core/test/combinations.test.ts` builds every combination, checks the self-check and what `inspect` reads back, that soft focus alone is unchanged, and that all additions with the contents of the earlier test firmware (`core/test/fw-helpers/test-firmware.ts`) give test firmware 017 byte for byte. `tools/testfw/build.ts` builds such test files.

## Licence

GR Mod is free software, licensed under the GNU General Public License version 2 only (SPDX: `GPL-2.0-only`); the full text is in `LICENSE`. A build given to anyone else has to come with its complete source under the same licence.

- The aspect-ratio compiler under `core/src/fw/aspect/` and `tools/aspect/` is a port of [DoYitNow/gr-custom-tool](https://github.com/DoYitNow/gr-custom-tool) (GPL-2.0-only); `third_party/gr-custom-tool/NOTICE.md` lists what is derived from it, and the C sources in `third_party/gr-custom-tool/native/` keep their own copyright lines.
- The monochrome looks follow the method of [lemonadesaltbagel/GR4-MonoUnlock](https://github.com/lemonadesaltbagel/GR4-MonoUnlock); no code of that project is included.
- Not covered by the licence: the sample picture `ui/src/assets/preview.jpg` , and Ricoh's firmware, which is not part of this repository (the program reads it from the user or downloads it from Ricoh's site under Ricoh's own licence terms).
