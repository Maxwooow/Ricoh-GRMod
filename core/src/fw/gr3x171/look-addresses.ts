// SPDX-License-Identifier: GPL-2.0-only
// Audited positive-offset CommonProperty Image Control reads in IIIx 1.60.
// Public UI getter and change comparison preserve the private slot identity.
// Writes, unrelated UserData fields and the diagnostic dump are not modified.
export const GR3X_TONE_READS = [
  [0x5328b898, 0xe5d3077c], // ldrb r0, [r3, #0x77c]
  [0x5328c190, 0xe5dc177c], // ldrb r1, [ip, #0x77c]
  [0x5328c348, 0xe5d2177c], // ldrb r1, [r2, #0x77c]
  [0x53515c00, 0xe5d1377c], // ldrb r3, [r1, #0x77c]
  [0x535c6d08, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6ea8, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6f04, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6f1c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c6fa8, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7148, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c71a4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c71bc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7248, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c73e8, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7444, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c745c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c74e8, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7688, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c76e4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c76fc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7788, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7928, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7984, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c799c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7a28, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7bc8, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7c24, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7c3c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7cc8, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7e68, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7ec4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7edc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c7f74, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8114, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8170, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8188, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8214, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c83d0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c83e4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c83fc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8494, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8634, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8690, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c86a8, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8744, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c88f8, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c890c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8924, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c89bc, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8b74, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8b88, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8ba0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8c38, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8df0, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8e04, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8e1c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c8eb4, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c906c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c9080, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c9098, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c9158, 0xe5d8277c], // ldrb r2, [r8, #0x77c]
  [0x535c925c, 0xe5d8277c], // ldrb r2, [r8, #0x77c]
  [0x535c92fc, 0xe5d8477c], // ldrb r4, [r8, #0x77c]
  [0x535c9318, 0xe5d8277c], // ldrb r2, [r8, #0x77c]
  [0x535c9384, 0xe5d7277c], // ldrb r2, [r7, #0x77c]
  [0x535c9488, 0xe5d7277c], // ldrb r2, [r7, #0x77c]
  [0x535c95ac, 0xe5d7477c], // ldrb r4, [r7, #0x77c]
  [0x535c95c8, 0xe5d7277c], // ldrb r2, [r7, #0x77c]
  [0x535c9664, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c9818, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c982c, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535c9844, 0xe5d1277c], // ldrb r2, [r1, #0x77c]
  [0x535ca39c, 0xe5d2c77c], // ldrb ip, [r2, #0x77c]
  [0x535ca47c, 0xe5d2377c], // ldrb r3, [r2, #0x77c]
  [0x535ca4b4, 0xe5d2377c], // ldrb r3, [r2, #0x77c]
  [0x535ca4bc, 0xe5d2377c], // ldrb r3, [r2, #0x77c]
  [0x535feee4, 0xe5d3277c], // ldrb r2, [r3, #0x77c]
  [0x535fef04, 0xe5d3277c], // ldrb r2, [r3, #0x77c]
  [0x536dfa38, 0xe5d3277c], // ldrb r2, [r3, #0x77c]
  [0x536e04ac, 0xe5d7277c], // ldrb r2, [r7, #0x77c]
  [0x536e06fc, 0xe5d7377c], // ldrb r3, [r7, #0x77c]
  [0x536e0bd8, 0xe5d5c77c], // ldrb ip, [r5, #0x77c]
  [0x536e1620, 0xe5d7177c], // ldrb r1, [r7, #0x77c]
  [0x536f34d8, 0xe5d9377c], // ldrb r3, [sb, #0x77c]
  [0x536f3518, 0xe5d9177c], // ldrb r1, [sb, #0x77c]
  [0x536f3564, 0xe5d9377c], // ldrb r3, [sb, #0x77c]
  [0x536f35a4, 0xe5d9177c], // ldrb r1, [sb, #0x77c]
  [0x536f3630, 0xe5d9e77c], // ldrb lr, [sb, #0x77c]
  [0x536f37c0, 0xe5d9177c], // ldrb r1, [sb, #0x77c]
  [0x536f44e8, 0xe5d4377c], // ldrb r3, [r4, #0x77c]
  [0x53704778, 0xe5d4e77c], // ldrb lr, [r4, #0x77c]
  [0x537047d0, 0xe5d4277c], // ldrb r2, [r4, #0x77c]
] as const;

/** Round 10 (films-r10.ts): the reads where a film is still taken as Standard (decisions from the look). */
export const GR3X_R10_TONE_READS = GR3X_TONE_READS.filter(([at]) => [0x53515c00, 0x536dfa38, 0x536e06fc, 0x536e1620].includes(at));

// Image Control parameter setters (SetSaturation etc.): the call that fetches the current
// look before the per-look jump table. Unknown looks fall through without writing.
export const GR3X_PARAMETER_SETTER_LOOKS = [
  0x532bff44, 0x532c0498, 0x532c09ec, 0x532c1060, 0x532c16d4, 0x532c1d48, 0x532c23bc, 0x532c2a30,
  0x532c2d2c, 0x532c2ec0, 0x532c3054, 0x532c3168, 0x532c32fc, 0x532c3568, 0x532c3bdc, 0x532c3f40,
  0x532c419c,
] as const;

// "Is Standard the stored look of the active set" checks in Standard's per-set parameter
// setters (they decide whether the live value is updated too). Sets 1 and 2: byte compare.
export const GR3X_STANDARD_ACTIVE_CHECKS = [
  [0x532605d4, 0xe5d331c4], [0x53260874, 0xe5d331c4], [0x53260b14, 0xe5d331c4],
  [0x53260f04, 0xe5d331c4], [0x532612f4, 0xe5d331c4], [0x532616e4, 0xe5d331c4],
  [0x53261ad4, 0xe5d331c4], [0x532621d4, 0xe5d331c4], [0x532625c4, 0xe5d331c4],
  [0x53262b74, 0xe5d331c6], [0x53262e14, 0xe5d331c6], [0x532630b4, 0xe5d331c6],
  [0x532634a4, 0xe5d331c6], [0x53263894, 0xe5d331c6], [0x53263c84, 0xe5d331c6],
  [0x53264074, 0xe5d331c6], [0x53264774, 0xe5d331c6], [0x53264b64, 0xe5d331c6],
] as const;
// Set 0: ldr r3,[r3,#0x1c0]; bic; bic; cmp r3,#0xb0000 (active set 0 and stored look 11).
export const GR3X_STANDARD_ACTIVE_CHECKS_SET0 = [
  0x5325e178, 0x5325e400, 0x5325e688, 0x5325ea54, 0x5325ee20, 0x5325f1ec, 0x5325f5b8, 0x5325fc78, 0x53260044,
] as const;

// Own film parameters (T6d). "Look of photo set n" setters (UserDataModel*, look): each is
// `ldr r3,[r0,#4]; ... strb r1,[r3,#0x1c2+2n]; bl 0x53277880` (push the record to the live values).
export const GR3X_PHOTO_STYLE_SETTERS = [0x5327db1c, 0x5327db3c, 0x5327db5c] as const;
// UserDataModel::LoadData and its only call (in the settings object's constructor).
export const GR3X_LOAD_DATA = 0x5324da0c;
export const GR3X_LOAD_CALL = 0x5324dedc;
// UserDataModel::SaveData and its only call, a tail branch of the power-off handler.
export const GR3X_SAVE_DATA = 0x532419fc;
export const GR3X_SAVE_CALL = 0x5322d7f8;
// Start-up zero fill: the literal of its end (ldr r2 at 0x530003ac). The 12 bytes from there to
// the heap base are not referenced; the first word becomes the table pointer.
export const GR3X_ZERO_FILL_END = 0x53000460;
export const GR3X_GAP = 0x55803ef4;
export const GR3X_HEAP_BASE = 0x55803f00;
/**
 * Round 8 (GR Mod 0.8.4): GR IV's ORIENT_WORD and FRAME_LOOK for the date imprint. The gap has no
 * room for two more words (0x55803ef4 the films' table pointer, 0x55803ef8 the look stash,
 * 0x55803efc the End Screen list's mode), so they are the three upper bytes of the mode word, whose
 * readers read its low byte only from round 8 on: the orientation of the picture being made
 * (value 0..3 | 0x80, GR IV's ORIENT_WORD value) and the look of that picture (the stash's look |
 * 0x8000, GR IV's FRAME_LOOK). Cleared at start (the zero fill reaches the heap base).
 */
export const GR3X_ORIENT_BYTE = 0x55803efd;
export const GR3X_FRAME_LOOK = 0x55803efe;
