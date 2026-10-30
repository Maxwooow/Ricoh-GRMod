// SPDX-License-Identifier: GPL-2.0-only
// Audited positive-offset CommonProperty Image Control reads in IIIx 1.60.
// Public UI getter and change comparison preserve the private slot identity.
// Writes, unrelated UserData fields and the diagnostic dump are not modified.
export const GR3X_TONE_READS = [
  [0x532891e8, 0xe5d3077c], // ldrb r0, [r3, #0x77c]
  [0x53289ae0, 0xe5dc177c], // ldrb r1, [ip, #0x77c]
  [0x53289c98, 0xe5d2177c], // ldrb r1, [r2, #0x77c]
  [0x535132b0, 0xe5d1377c], // ldrb r3, [r1, #0x77c]
  [0x535c4290, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4430, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c448c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c44a4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4530, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c46d0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c472c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4744, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c47d0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4970, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c49cc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c49e4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4a70, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4c10, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4c6c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4c84, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4d10, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4eb0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4f0c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4f24, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c4fb0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5150, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c51ac, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c51c4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5250, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c53f0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c544c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5464, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c54fc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c569c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c56f8, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5710, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c579c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5958, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c596c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5984, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5a1c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5bbc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5c18, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5c30, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5ccc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5e80, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5e94, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5eac, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c5f44, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c60fc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6110, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6128, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c61c0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6378, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c638c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c63a4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c643c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c65f4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6608, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6620, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c66e0, 0xe5d8277c], // ldrb r2, [r8, #0x77c]
  [0x535c67e4, 0xe5d8277c], // ldrb r2, [r8, #0x77c]
  [0x535c6884, 0xe5d8477c], // ldrb r4, [r8, #0x77c]
  [0x535c68a0, 0xe5d8277c], // ldrb r2, [r8, #0x77c]
  [0x535c690c, 0xe5d7277c], // ldrb r2, [r7, #0x77c]
  [0x535c6a10, 0xe5d7277c], // ldrb r2, [r7, #0x77c]
  [0x535c6b34, 0xe5d7477c], // ldrb r4, [r7, #0x77c]
  [0x535c6b50, 0xe5d7277c], // ldrb r2, [r7, #0x77c]
  [0x535c6bec, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6da0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6db4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6dcc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7924, 0xe5d2c77c], // ldrb ip, [r2, #0x77c]
  [0x535c7a04, 0xe5d2377c], // ldrb r3, [r2, #0x77c]
  [0x535c7a3c, 0xe5d2377c], // ldrb r3, [r2, #0x77c]
  [0x535c7a44, 0xe5d2377c], // ldrb r3, [r2, #0x77c]
  [0x535fc46c, 0xe5d3277c], // ldrb r2, [r3, #0x77c]
  [0x535fc48c, 0xe5d3277c], // ldrb r2, [r3, #0x77c]
  [0x536db7d0, 0xe5d3277c], // ldrb r2, [r3, #0x77c]
  [0x536dc244, 0xe5d7277c], // ldrb r2, [r7, #0x77c]
  [0x536dc494, 0xe5d7377c], // ldrb r3, [r7, #0x77c]
  [0x536dc970, 0xe5d5c77c], // ldrb ip, [r5, #0x77c]
  [0x536dd3b8, 0xe5d7177c], // ldrb r1, [r7, #0x77c]
  [0x536ef270, 0xe5d9377c], // ldrb r3, [sb, #0x77c]
  [0x536ef2b0, 0xe5d9177c], // ldrb r1, [sb, #0x77c]
  [0x536ef2fc, 0xe5d9377c], // ldrb r3, [sb, #0x77c]
  [0x536ef33c, 0xe5d9177c], // ldrb r1, [sb, #0x77c]
  [0x536ef3c8, 0xe5d9e77c], // ldrb lr, [sb, #0x77c]
  [0x536ef558, 0xe5d9177c], // ldrb r1, [sb, #0x77c]
  [0x536f0280, 0xe5d4377c], // ldrb r3, [r4, #0x77c]
  [0x53700510, 0xe5d4e77c], // ldrb lr, [r4, #0x77c]
  [0x53700568, 0xe5d4277c], // ldrb r2, [r4, #0x77c]
] as const;

/** Round 10 (films-r10.ts): the reads where a film is still taken as Standard (decisions from the look). */
export const GR3X_R10_TONE_READS = GR3X_TONE_READS.filter(([at]) => [0x535132b0, 0x536db7d0, 0x536dc494, 0x536dd3b8].includes(at));

// Image Control parameter setters (SetSaturation etc.): the call that fetches the current
// look before the per-look jump table. Unknown looks fall through without writing.
export const GR3X_PARAMETER_SETTER_LOOKS = [
  0x532bd894, 0x532bdde8, 0x532be33c, 0x532be9b0, 0x532bf024, 0x532bf698, 0x532bfd0c, 0x532c0380,
  0x532c067c, 0x532c0810, 0x532c09a4, 0x532c0ab8, 0x532c0c4c, 0x532c0eb8, 0x532c152c, 0x532c1890,
  0x532c1aec,
] as const;

// "Is Standard the stored look of the active set" checks in Standard's per-set parameter
// setters (they decide whether the live value is updated too). Sets 1 and 2: byte compare.
export const GR3X_STANDARD_ACTIVE_CHECKS = [
  [0x5325df24, 0xe5d331c4], [0x5325e1c4, 0xe5d331c4], [0x5325e464, 0xe5d331c4],
  [0x5325e854, 0xe5d331c4], [0x5325ec44, 0xe5d331c4], [0x5325f034, 0xe5d331c4],
  [0x5325f424, 0xe5d331c4], [0x5325fb24, 0xe5d331c4], [0x5325ff14, 0xe5d331c4],
  [0x532604c4, 0xe5d331c6], [0x53260764, 0xe5d331c6], [0x53260a04, 0xe5d331c6],
  [0x53260df4, 0xe5d331c6], [0x532611e4, 0xe5d331c6], [0x532615d4, 0xe5d331c6],
  [0x532619c4, 0xe5d331c6], [0x532620c4, 0xe5d331c6], [0x532624b4, 0xe5d331c6],
] as const;
// Set 0: ldr r3,[r3,#0x1c0]; bic; bic; cmp r3,#0xb0000 (active set 0 and stored look 11).
export const GR3X_STANDARD_ACTIVE_CHECKS_SET0 = [
  0x5325bac8, 0x5325bd50, 0x5325bfd8, 0x5325c3a4, 0x5325c770, 0x5325cb3c, 0x5325cf08, 0x5325d5c8, 0x5325d994,
] as const;

// Own film parameters (T6d). "Look of photo set n" setters (UserDataModel*, look): each is
// `ldr r3,[r0,#4]; ... strb r1,[r3,#0x1c2+2n]; bl 0x532751d0` (push the record to the live values).
export const GR3X_PHOTO_STYLE_SETTERS = [0x5327b46c, 0x5327b48c, 0x5327b4ac] as const;
// UserDataModel::LoadData and its only call (in the settings object's constructor).
export const GR3X_LOAD_DATA = 0x5324b35c;
export const GR3X_LOAD_CALL = 0x5324b82c;
// UserDataModel::SaveData and its only call, a tail branch of the power-off handler.
export const GR3X_SAVE_DATA = 0x5323f34c;
export const GR3X_SAVE_CALL = 0x5322b180;
// Start-up zero fill: the literal of its end (ldr r2 at 0x530003ac). The 12 bytes from there to
// the heap base are not referenced; the first word becomes the table pointer.
export const GR3X_ZERO_FILL_END = 0x53000460;
export const GR3X_GAP = 0x55803c34;
export const GR3X_HEAP_BASE = 0x55803c40;
/**
 * Round 8 (GR Mod 0.8.4): GR IV's ORIENT_WORD and FRAME_LOOK for the date imprint. The gap has no
 * room for two more words (0x55803c34 the films' table pointer, 0x55803c38 the look stash,
 * 0x55803c3c the End Screen list's mode), so they are the three upper bytes of the mode word, whose
 * readers read its low byte only from round 8 on: the orientation of the picture being made
 * (value 0..3 | 0x80, GR IV's ORIENT_WORD value) and the look of that picture (the stash's look |
 * 0x8000, GR IV's FRAME_LOOK). Cleared at start (the zero fill reaches the heap base).
 */
export const GR3X_ORIENT_BYTE = 0x55803c3d;
export const GR3X_FRAME_LOOK = 0x55803c3e;
