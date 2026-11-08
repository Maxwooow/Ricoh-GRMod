# Optional additive hue-sector fitting

The desktop option **Continuous hue-sector correction** is off by default.
It fits added-slot hue matrices as `S + C - I`, where `S` is Standard's sector
block and `C` the fitted correction. The sum preserves the boundary continuity
of the two blocks. Offline comparisons improve sector-boundary continuity.

`Engine.convertPreset('cube', text, undefined, { hue: true, additiveHue: true })`
enables it for a conversion. The same option applies to the XMP hue fit.
Omitting it or passing `false` keeps upstream 0.8.9's multiplication and exact
output. The desktop saves the choice per camera family and refits applicable
current presets when it changes. GR III / IIIx conversion is unaffected.

This changes computer-side import fitting. The owner's existing camera styles
were imported with the option off. The enabled option has offline comparisons;
it has not been used for photographs on the owner's camera.

To reproduce the continuity, guarded-fit, API and firmware-payload tests:

```sh
GRMOD_GR4_120_FIRMWARE=/path/to/official120.bin npm -w core test -- hue.test.ts additive-hue-import.test.ts
npm -w core run typecheck
npm -w ui run typecheck
```

The 1.11 fixture is `core/testdata/private/official.bin`; private official files
are optional and never committed. The API test runs both GR IV 1.11 and 1.20,
checks that the explicit option changes a synthetic LUT's fit, then builds and
reads back its exact matrix, curves, post matrix and hue block. Additional local
Reala LUT comparisons checked default-off full conversion JSON and resulting
containers byte-for-byte against a separate clean upstream build on both versions.
The unchanged upstream 1.20 boot checker's directory and ratio-menu functions
pass on the resulting fitting build. Its dedicated look-layout/settings suite
also passes on off/on payloads. A supplementary generic settings-wrapper probe
faulted on a build byte-identical to clean upstream; that diagnostic is retained
and a complete generic boot pass is not claimed. This PR changes no firmware hooks.

The complete core run retains the same seven failures as clean upstream on this
machine: three missing historical private fixtures, one floating JSON hash and
three existing UI API tests. Their expectations are preserved.
