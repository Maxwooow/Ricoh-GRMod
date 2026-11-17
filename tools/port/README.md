# Ports to new official firmware (development tools)

GR Mod's patches name firmware addresses. When Ricoh ships a new release, every function and table
moves, and some code changes. There are two ways a program is made to build a new release; the
engine picks the program by the SHA-256 of the file it opens and never mixes two.

**The same program with another address table** (GR IV 1.21). `core/src/fw/gr4v120` is written for
1.20 and builds 1.21 as well: every address goes through `adr(...)`, every other value that differs
is `byRelease({ '1.20': a, '1.21': b })`, and `core/src/fw/gr4v121` holds only 1.21's own files (its
`target.ts`, the address table `addresses.ts` written by `addresses.py` from the address map, the
compiled native modules). See `core/src/fw/release.ts`. This is how a new release is added from now
on, where the program allows it.

**A generated copy** (the others, for now). A copy of the program for the new release, next to the
one it was made from: the sources with every address substituted through the map, and the hand
edits of a `.patch`.

| Release | From | Config | What is generated |
|---|---|---|---|
| GR III 2.20 / GR IIIx 1.70 | 2.10 / 1.60 (`fw/gr3x`, `tools/gr3x`) | `gr3-p2.json` | `fw/gr3x170`, `tools/gr3x170` |
| GR III 2.21 / GR IIIx 1.71 | 2.20 / 1.70 (`fw/gr3x170`, `tools/gr3x170`) | `gr3-p3.json` | `fw/gr3x171`, `tools/gr3x171` |
| GR IV 1.20 (= GR IV Monochrome 1.10) | 1.11 (`fw/*.ts`, `fw/aspect`, `tools/{aspect,datestamp,...}`) | `gr4-120.json` | `fw/gr4v120`, `tools/gr4v120` |
| GR IV 1.21 (= GR IV Monochrome 1.11) | 1.20 (`tools/gr4v120`) | `gr4-121.json` | `tools/gr4v121` only (the development tools and, through them, the compiled native modules in `fw/gr4v121/aspect`); the program is `fw/gr4v120` |

A new release also goes into `releases.json` at the root (`node tools/releases/generate.mjs`), which
the download lists and the README's table are written from.

## Adding a release to a program that has a target (GR IV 1.22, say)

1. `addrmap.py` and the overrides, as below: the map from the program's own release (1.20) to the new one.
   When the map is made from the previous release instead (1.21 to 1.22), list both maps for the new
   table in `addresses.py`: it follows them in order.
2. Add the table to `addresses.py` and the directory to `OVERLAYS` in `core/overlays.mjs`; write
   `fw/gr4v122/target.ts` (as `fw/gr4v121/target.ts`) and `index.d.ts`; add the release to the list in
   `fw/gr4v120/target.ts` and in the other releases' targets.
3. Every `byRelease` of the program now fails until it has a value for the new release: that is the
   list of places to look at (expected instruction words, sizes, hashes). Code Ricoh changed gets a
   `byRelease` or a branch on `release` there.
4. Generate the tools (`generate.py` with a config like `gr4-121.json`) and run their post steps: they
   compile the native modules into `fw/gr4v122/aspect`.
5. Add the program to the engine (`core/src/app/engine.ts`), the release to `releases.json`, and record
   its golden builds (`GRMOD_GOLDEN=record`, `core/test/golden-builds.test.ts`) once the emulator checks
   and a camera test have passed. The other releases' golden builds must not change.

## Keeping the copies in step

A generated copy is never edited on its own:

- a fix in the original is generated into its copies (`generate.py X.json`, in the order of the table: a copy
  can be the source of the next one);
- a change that only the copy needs is made in the copy and then recorded in its patch
  (`generate.py X.json --save-patch`).

`python3 tools/port/check.py` (also `npm run check`, and part of the Tests workflow) generates every port into a
temporary directory, applies its patch and compares the text files with the committed ones. It fails when a copy
is no longer what its source, map and patch give, which is how a forgotten step shows. The compiled native
modules (`generated` in the config) are not compared: they need the compilers of the post steps.
`python3 tools/port/addresses.py --check` does the same for the address tables.

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
