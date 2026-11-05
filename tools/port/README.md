# Ports to new official firmware (development tools)

GR Mod's patches name firmware addresses. When Ricoh ships a new release, every function and table
moves, and some code changes. A port is a **generated copy** of the program for the new release,
next to the one it was made from; the engine picks the program by the SHA-256 of the file it opens
and never mixes the two. Nothing here is part of the program.

| Port | From | Config | Copy |
|---|---|---|---|
| GR III 2.20 / GR IIIx 1.70 | 2.10 / 1.60 (`fw/gr3x`, `tools/gr3x`) | `gr3-p2.json` | `fw/gr3x170`, `tools/gr3x170` |
| GR IV 1.20 (= GR IV Monochrome 1.10) | 1.11 (`fw/*.ts`, `fw/aspect`, `tools/{aspect,datestamp,...}`) | `gr4-120.json` | `fw/gr4v120`, `tools/gr4v120` |

Both are **experimental**: the engine opens the new files only with `OpenOptions.newFirmware`, which
only the experimental "new firmware" line of the app sets (a version containing `newfw` and `exp`,
see `shell/updates.go`).

## How a port is made

1. `addrmap.py OLD-RTOS NEW-RTOS --ram ... --overrides X-overrides.json --out X-map.json --runs RUNS --loose FILES`
   maps every address written in the sources. An address is `ok` only when the old code around it
   (16 words, relocations masked, at least 4 distinct words) is found at one place of the new image
   and every reference agrees, or (data, RAM) when the references agree; aligned RAM data also needs
   a reference. Everything else is `manual`.
2. Manual addresses are resolved by hand into `X-overrides.json` (old -> new, with the evidence:
   side-by-side code, references, `datacheck.py` word-by-word comparison up to relocation, the
   upstream reference's own address for the new release, ...).
3. `generate.py X.json` copies the sources with every address substituted through the map, the
   directory names renamed and (GR IV) relative imports re-linked to the copies or to the shared
   modules; then applies `X.patch`, the hand edits (code Ricoh changed, sizes, counts, text and icon
   numbers, the profile). With `"lenient"`, an address the map cannot resolve is left as it is for
   the hand edits; after the patch, no old address may be left anywhere in the copy, in any syntax.
   `--save-patch` records the hand edits (the difference between the plain substituted copy and the
   copy as it is).
4. Post steps recompile the native modules of the copy.

## Checks

- `compare_builds.mts` (GR III): builds the same recipes on both programs and explains every word
  that is not the relocation of the other build's.
- The copies of the emulator checks (`tools/gr3x170/validate_test.py`; `tools/gr4v120/*/..._check.py`,
  `tools/gr4v120/aspect/boot_checks.py`) run on builds of the new release against its official RTOS.
- GR IV: `tools/gr4v120/aspect/check_facts120.py` (the measured facts are also 1.20's),
  `tools/gr4v120/aspect/verify120.py` (the added ratios read back through the upstream reference's
  1.20 code as its 1.20 planner says), `gr4_catalog_ids.py` (1.20 renumbered texts and icons: the
  1.20 number of each 1.11 one).
- `core/test/new-firmware.test.ts`, `core/test/gr3-p2-equivalence.test.ts`.
