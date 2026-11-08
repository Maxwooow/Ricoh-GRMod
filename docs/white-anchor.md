# Optional LUT white-point preservation

The desktop **Keep the LUT's white** option is off by default. When enabled for a
GR IV Cube import, it gives the LUT's white more weight in the RGB curve fit and
the subsequent hue-sector fit. This improves white-point matching in offline
comparisons. It retains the LUT's intended white, which may itself be tinted.

Use `Engine.convertPreset('cube', text, undefined, { keepWhite: true })`, adding
`hue: true` for an added slot's hue fit. Omitted or false keeps upstream 0.8.9's
exact fitting output. The desktop saves the setting per camera family and refits
current Cube presets when it changes. XMP and GR III / IIIx conversion keep their
existing path.

The option affects fitting on the computer. The owner's existing styles were
imported with it off; the enabled option has offline comparisons and has not
been used for photographs on the owner's camera.

```sh
GRMOD_GR4_120_FIRMWARE=/path/to/official120.bin npm -w core test -- refine.test.ts hue.test.ts white-anchor-import.test.ts
npm -w core run typecheck
npm -w ui run typecheck
```

The private 1.11 input is `core/testdata/private/official.bin`; no firmware or
LUT files are committed. The synthetic regression tests check white retention,
explicit option forwarding on both firmware versions and exact readback of
matrix, curves, post matrix and hue block. Separate local Reala comparisons
verify default-off complete fitting JSON and resulting containers byte-for-byte
against clean upstream for 1.11 and 1.20.

The unchanged upstream 1.20 boot checker's directory and ratio-menu functions
pass on the resulting fitting build. Its dedicated look-layout/settings suite
also passes on off/on payloads. A supplementary generic settings-wrapper probe
faulted on a build byte-identical to clean upstream; that diagnostic is retained
and a complete generic boot pass is not claimed. This PR changes no firmware hooks.

The full core suite retains the same seven failures as clean upstream here:
three missing historical private fixtures, one floating JSON hash and three
existing UI API tests. Their expectations are preserved.
