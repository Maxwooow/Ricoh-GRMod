# DoYitNow/gr-custom-tool

Source: https://github.com/DoYitNow/gr-custom-tool, commit `0c15c8f` ("Keep ld.lld aliases intact during toolchain discovery").
Copyright (C) 2026 DoYitNow. Licence: GPL-2.0-only (`LICENSE` in this directory; the author's statement is in `AUTHOR_STATEMENT.md`).

GR Mod's "added aspect ratios" feature is a port of that project's crop compiler. What comes from it:

| In GR Mod | Derived from |
| --- | --- |
| `core/src/fw/aspect/build.ts`, `geometry.ts`, `fraction.ts` | `gr4_editor/crop_compiler.py`, `crop_geometry.py`, `crop_raw.py`, `crop_registry.py`, `crop_state.py`, `crop_image_identity.py`, `official_scaffold.py`, `official_catalogs.py` (rewritten in TypeScript; the hook addresses, the appended code and the data layout are the reference's) |
| `core/src/fw/aspect/native.ts` | `gr4_editor/native/crop_state.c`, `crop_image_identity.c`, `crop_image_map.c` compiled with clang for every list length, stored as machine code plus relocations. The unmodified C sources are in `native/` here; `tools/aspect/gen_native.py` regenerates the file from them. |
| `core/src/fw/aspect/facts.ts` | numbers the reference measures at run time by emulating the firmware, recorded once (`tools/aspect/gen_facts.py`) |
| `tools/aspect/*.py` | development tools that import the reference as a library to compare results (not part of the program) |

Not taken: the reference's container writer, version bump, JSON footer, icon renderer, web interface and power-off image code.

Changes made in the port, as required by section 2(a) of the licence (October 2026):

- rewritten in TypeScript, with a small ARM assembler (`arm.ts`) in place of clang at run time;
- added ratios always get the identities 7, 8, ... in list order; ratios equal to a factory ratio are refused; at most 8; names are printable ASCII;
- the firmware version is left at 1.11 and nothing is appended after the code;
- the result is placed in the container by GR Mod's own code (`package.ts`, `../container.ts`);
- since GR Mod 0.3.0 one piece of code that is not in the reference is appended after the reference's (`installPlaybackDecode` in `build.ts`: the playback decode buffer for photo heights that are not a multiple of 8), and `tools/aspect/playback_check.py` checks it.

Every file listed in the table carries `SPDX-License-Identifier: GPL-2.0-only`. A firmware file built with added ratios contains the compiled C code above.

## GR IIIx HDF 1.60 local port (11 October 2026)

`core/src/fw/gr3x/` adapts the reference's crop menu, geometry, image identity,
RAW-development and statistics-map design to the independently inspected IIIx image.
`tools/gr3x/native/map.c` derives its crop-grid algorithm from
`gr4_editor/native/crop_image_map.c`; the IIIx port changes the map/record sizes,
pointer layout, aspect identifiers, three-strip accounting, allocation and clone
handling. `core/src/fw/gr3x/map-native.ts` contains its relocatable ARM code;
`tools/gr3x/compile_map.py` regenerates it from the included source.

The IIIx fixed list uses IDs 4–10 plus native 0/3, IIIx-specific hook addresses,
8-byte icon descriptors and a separate package marker. The version stays 1.60.
The local validation tool imports the pinned reference Python decoder for an
independent check; it is not copied into the runtime. Physical camera operation
of this T1 candidate has not been tested. All added port source uses GPL-2.0-only.
