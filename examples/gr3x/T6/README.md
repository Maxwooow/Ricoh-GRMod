# Local T6 film inputs

The IIIx image-control implementation supports nine independently named CUBE
slots and custom icons. The local T6 test configuration uses Provia 100F/400F,
Velvia 50/100, Portra 400, Gold 200, Ektar 100, Kodachrome 64 and CineStill 800T.
It is a community-derived approximation, not manufacturer camera profiles.

This directory commits provenance and packaging-colour references, not the
third-party CUBE/PNG assets. Downloaded/generated assets remain ignored locally.
`prepare-t6-luts.py` downloads pinned t3mujinpack Hald files, verifies the recorded
hashes, converts them to 33³ CUBE, and fetches the separately supplied PictureFX
CineStill file from the author's public download. It runs only when explicitly
invoked. `SOURCES.json` records author URLs, hashes and conversion information.

The first eight inputs are from João Almeida's **t3mujinpack**, pinned at
`0b421f3e25209ed78253d1724a29cc6255c5e7fe`, under MIT; the copyright/license
notice is preserved in `LICENSE-t3mujinpack.txt`. CineStill is Marc Roovers'
**PictureFX CineStill 800T v2.0 N125**, without 85B daylight correction.
Its free personal download does not establish a general redistribution grant;
that file is deliberately not bundled in this public source contribution.

Icons are code-drawn 40×40 pixel labels in `film-icons.ts`, using packaging
colours and references listed in `ICON-SOURCES.json`. No downloaded logo artwork
or product photograph is bundled. The names are also used by native slot tests,
which do not require downloading any LUT.

For preparation/reproduction, see `docs/GR3X_HDF.md`. The CUBE fit is a matrix
plus three curves, not a full 3D LUT; CineStill has no spatial halation. Camera
rendering and saved-setting behaviour of the nine T6 films remain unverified.
