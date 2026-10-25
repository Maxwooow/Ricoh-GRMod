// SPDX-License-Identifier: GPL-2.0-only
// Audited positive-offset CommonProperty Image Control reads in IIIx 1.60.
// Public UI getter and change comparison preserve the private slot identity.
// Writes, unrelated UserData fields and the diagnostic dump are not modified.
export const GR3X_TONE_READS = [
  [0x53289110, 0xe5d3077c], // ldrb r0, [r3, #0x77c]
  [0x53289a08, 0xe5dc177c], // ldrb r1, [ip, #0x77c]
  [0x53289bc0, 0xe5d2177c], // ldrb r1, [r2, #0x77c]
  [0x535131c0, 0xe5d1377c], // ldrb r3, [r1, #0x77c]
  [0x535c41a0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4340, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c439c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c43b4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4440, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c45e0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c463c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4654, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c46e0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4880, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c48dc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c48f4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4980, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4b20, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4b7c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4b94, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4c20, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4dc0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4e1c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4e34, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4ec0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5060, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c50bc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c50d4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5160, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5300, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c535c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5374, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c540c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c55ac, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5608, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5620, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c56ac, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5868, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c587c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5894, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c592c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5acc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5b28, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5b40, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5bdc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5d90, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5da4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5dbc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5e54, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c600c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6020, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6038, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c60d0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6288, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c629c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c62b4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c634c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6504, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6518, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6530, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c65f0, 0xe5d8277c], // ldrb r2, [r8, #0x77c]
  [0x535c66f4, 0xe5d8277c], // ldrb r2, [r8, #0x77c]
  [0x535c6794, 0xe5d8477c], // ldrb r4, [r8, #0x77c]
  [0x535c67b0, 0xe5d8277c], // ldrb r2, [r8, #0x77c]
  [0x535c681c, 0xe5d7277c], // ldrb r2, [r7, #0x77c]
  [0x535c6920, 0xe5d7277c], // ldrb r2, [r7, #0x77c]
  [0x535c6a44, 0xe5d7477c], // ldrb r4, [r7, #0x77c]
  [0x535c6a60, 0xe5d7277c], // ldrb r2, [r7, #0x77c]
  [0x535c6afc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6cb0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6cc4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6cdc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7834, 0xe5d2c77c], // ldrb ip, [r2, #0x77c]
  [0x535c7914, 0xe5d2377c], // ldrb r3, [r2, #0x77c]
  [0x535c794c, 0xe5d2377c], // ldrb r3, [r2, #0x77c]
  [0x535c7954, 0xe5d2377c], // ldrb r3, [r2, #0x77c]
  [0x535fc37c, 0xe5d3277c], // ldrb r2, [r3, #0x77c]
  [0x535fc39c, 0xe5d3277c], // ldrb r2, [r3, #0x77c]
  [0x536db7f8, 0xe5d3277c], // ldrb r2, [r3, #0x77c]
  [0x536dc26c, 0xe5d7277c], // ldrb r2, [r7, #0x77c]
  [0x536dc4bc, 0xe5d7377c], // ldrb r3, [r7, #0x77c]
  [0x536dc998, 0xe5d5c77c], // ldrb ip, [r5, #0x77c]
  [0x536dd3e0, 0xe5d7177c], // ldrb r1, [r7, #0x77c]
  [0x536ef298, 0xe5d9377c], // ldrb r3, [sb, #0x77c]
  [0x536ef2d8, 0xe5d9177c], // ldrb r1, [sb, #0x77c]
  [0x536ef324, 0xe5d9377c], // ldrb r3, [sb, #0x77c]
  [0x536ef364, 0xe5d9177c], // ldrb r1, [sb, #0x77c]
  [0x536ef3f0, 0xe5d9e77c], // ldrb lr, [sb, #0x77c]
  [0x536ef580, 0xe5d9177c], // ldrb r1, [sb, #0x77c]
  [0x536f02a8, 0xe5d4377c], // ldrb r3, [r4, #0x77c]
  [0x53700538, 0xe5d4e77c], // ldrb lr, [r4, #0x77c]
  [0x53700590, 0xe5d4277c], // ldrb r2, [r4, #0x77c]
] as const;

/** Round 10 (films-r10.ts): the reads where a film is still taken as Standard (decisions from the look). */
export const GR3X_R10_TONE_READS = GR3X_TONE_READS.filter(([at]) => [0x535131c0, 0x536db7f8, 0x536dc4bc, 0x536dd3e0].includes(at));

// Image Control parameter setters (SetSaturation etc.): the call that fetches the current
// look before the per-look jump table. Unknown looks fall through without writing.
export const GR3X_PARAMETER_SETTER_LOOKS = [
  0x532bd7a4, 0x532bdcf8, 0x532be24c, 0x532be8c0, 0x532bef34, 0x532bf5a8, 0x532bfc1c, 0x532c0290,
  0x532c058c, 0x532c0720, 0x532c08b4, 0x532c09c8, 0x532c0b5c, 0x532c0dc8, 0x532c143c, 0x532c17a0,
  0x532c19fc,
] as const;

// "Is Standard the stored look of the active set" checks in Standard's per-set parameter
// setters (they decide whether the live value is updated too). Sets 1 and 2: byte compare.
export const GR3X_STANDARD_ACTIVE_CHECKS = [
  [0x5325de4c, 0xe5d331c4], [0x5325e0ec, 0xe5d331c4], [0x5325e38c, 0xe5d331c4],
  [0x5325e77c, 0xe5d331c4], [0x5325eb6c, 0xe5d331c4], [0x5325ef5c, 0xe5d331c4],
  [0x5325f34c, 0xe5d331c4], [0x5325fa4c, 0xe5d331c4], [0x5325fe3c, 0xe5d331c4],
  [0x532603ec, 0xe5d331c6], [0x5326068c, 0xe5d331c6], [0x5326092c, 0xe5d331c6],
  [0x53260d1c, 0xe5d331c6], [0x5326110c, 0xe5d331c6], [0x532614fc, 0xe5d331c6],
  [0x532618ec, 0xe5d331c6], [0x53261fec, 0xe5d331c6], [0x532623dc, 0xe5d331c6],
] as const;
// Set 0: ldr r3,[r3,#0x1c0]; bic; bic; cmp r3,#0xb0000 (active set 0 and stored look 11).
export const GR3X_STANDARD_ACTIVE_CHECKS_SET0 = [
  0x5325b9f0, 0x5325bc78, 0x5325bf00, 0x5325c2cc, 0x5325c698, 0x5325ca64, 0x5325ce30, 0x5325d4f0, 0x5325d8bc,
] as const;

// Own film parameters (T6d). "Look of photo set n" setters (UserDataModel*, look): each is
// `ldr r3,[r0,#4]; ... strb r1,[r3,#0x1c2+2n]; bl 0x532750f8` (push the record to the live values).
export const GR3X_PHOTO_STYLE_SETTERS = [0x5327b394, 0x5327b3b4, 0x5327b3d4] as const;
// UserDataModel::LoadData and its only call (in the settings object's constructor).
export const GR3X_LOAD_DATA = 0x5324b284;
export const GR3X_LOAD_CALL = 0x5324b754;
// UserDataModel::SaveData and its only call, a tail branch of the power-off handler.
export const GR3X_SAVE_DATA = 0x5323f274;
export const GR3X_SAVE_CALL = 0x5322b0a8;
// Start-up zero fill: the literal of its end (ldr r2 at 0x530003ac). The 12 bytes from there to
// the heap base are not referenced; the first word becomes the table pointer.
export const GR3X_ZERO_FILL_END = 0x53000460;
export const GR3X_GAP = 0x55804374;
export const GR3X_HEAP_BASE = 0x55804380;
/**
 * Round 8 (GR Mod 0.8.4): GR IV's ORIENT_WORD and FRAME_LOOK for the date imprint. The gap has no
 * room for two more words (0x55804374 the films' table pointer, 0x55804378 the look stash,
 * 0x5580437c the End Screen list's mode), so they are the three upper bytes of the mode word, whose
 * readers read its low byte only from round 8 on: the orientation of the picture being made
 * (value 0..3 | 0x80, GR IV's ORIENT_WORD value) and the look of that picture (the stash's look |
 * 0x8000, GR IV's FRAME_LOOK). Cleared at start (the zero fill reaches the heap base).
 */
export const GR3X_ORIENT_BYTE = 0x5580437d;
export const GR3X_FRAME_LOOK = 0x5580437e;
