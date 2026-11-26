# Checks of the GR III / IIIx extras (development tools)

Emulator and read-back checks of the additions in `core/src/fw/gr3x/extras.ts`, run on a firmware
built with `tools/testfw/build-gr3.ts`. They name the addresses of each release themselves or look
them up in the generated address tables, so they are not part of the generated ports of `tools/gr3x`.

- `grid_check.py`: custom grid lines, with the camera's own drawing code.
- `units_check.py`: distances in feet, from the built text and icon directories.
- `battery_check.py`: battery percentage, the camera's GetBatteryIcon and its two callers with synthetic power reports.
- `rxdis.py`: a small disassembler for the sub-CPU (Renesas RX) program, used to read how it fills the power report.
- `shadow_check.py`: the learned Auto for Shadow Correction, with the camera's own shadow-correction core against the
  reference model (GR IV's `tools/gr4v120/shadowml/ref.py`); `shadowml/` holds the module's GR III source and its `gen.py`.
- `matte_check.py`: matte live view: what the live view's consumers receive, the grid view's bands, lines and diagonals.
- `hdr_check.py`: the HDR gain map, with the camera's JPEG encode step and JPEG writer (synthetic picture).
- `halation_check.py` (with `halation_ref.mts`): the films' halation switch: the JPEG step's module against GR Mod's
  reference, the development step's stash, the parameter screen's rows, with the switch on, off and absent.
- `addmap.py`: adds the addresses of new GR III source files to the port maps (2.10 -> 2.20 -> 2.21).
- `menu_check.py`: added still-menu lines and the wide menus (menu-lines.ts) with soft focus as their first line, with
  the camera's own menu builder, OK, line drawing and list code; `build_pictures.mts` makes the builds with End
  Screen pictures and films it is also run on.
- `settings_survey.py`: the free bytes of the user-settings record (menu-lines.ts, GR3X_FREE_SETTING_BYTES), from the
  camera's own merge and Save-to-U code run in the emulator, in all three releases.
