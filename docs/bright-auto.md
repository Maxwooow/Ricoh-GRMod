# Brighter Auto LCD curves (GR IV 1.11 / 1.20)

The desktop Auto screen brightness control starts at **stock**. `balanced` lifts
the indoor range moderately; `bright` lifts it further. Both end at 1500, the
existing fixed Outdoor View +2 target. They apply when the camera's Outdoor View
Setting is Auto. The owner reports daily use of **balanced** on GR IV HDF 1.11
and 1.20; the bright curve has offline validation only.

`Engine.buildFirmware(..., { brightAuto: 'balanced' })` selects the balanced
curve; `'bright'` or `true` selects bright. An omitted option or `false` preserves
upstream's bytes. This PR contains no AWB, shadow, AF or other learned module.
The module checks the official table and instructions before patching. It selects an
18-point table and patches two limits, with no appended executable code. The revision-3
recipe uses second-feature bit 2 and one curve byte (1 bright, 2 balanced); HDR
and ADJ bits keep their upstream meaning. Builds without this option retain the
upstream recipe exactly. Existing saved projects default to stock.

Run the two-version build/readback and option tests with private official files:

```sh
GRMOD_GR4_120_FIRMWARE=/path/to/official120.bin npm -w core test -- brightauto.test.ts
npm -w core run typecheck
npm -w ui run typecheck
```

The 1.11 fixture is `core/testdata/private/official.bin`. Private data stay outside
Git. To replay the actual complete LCD function, including its stock division
helper, on any extracted image:

```sh
python3 tools/brightauto/check.py 1.20 /path/to/image.rtos balanced
```

The checker covers low inputs, both sides of every table knot, deterministic
random inputs and the full unsigned upper range; it checks return values against
integer interpolation and preserves R4–R11/SP. `stock`, `bright` and firmware
`1.11` are also supported. The original 1.20 boot checker was additionally run
on actual ratio-plus-brightness builds with both curves; its scope excludes
extra-slot/Halation UI.

`tools/port/gr4-120-brightauto.json` regenerates only the 1.20 brightness module.
The main 1.20 port config and its hand patch include the new module and options.
Address evidence lives in `tools/port/gr4-120-overrides.d/bright-auto.json`.
