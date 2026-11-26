# Checks of the GR III / IIIx extras (development tools)

Emulator and read-back checks of the additions in `core/src/fw/gr3x/extras.ts`, run on a firmware
built with `tools/testfw/build-gr3.ts`. They name the addresses of each release themselves or look
them up in the generated address tables, so they are not part of the generated ports of `tools/gr3x`.

- `grid_check.py`: custom grid lines, with the camera's own drawing code.
- `units_check.py`: distances in feet, from the built text and icon directories.
- `halation_check.py` (with `halation_ref.mts`): the films' halation switch: the JPEG step's module against GR Mod's
  reference, the development step's stash, the parameter screen's rows, with the switch on, off and absent.
- `addmap.py`: adds the addresses of new GR III source files to the port maps (2.10 -> 2.20 -> 2.21).
