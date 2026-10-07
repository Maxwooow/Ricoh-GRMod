// Copyright (C) 2026 DoYitNow
// SPDX-License-Identifier: GPL-2.0-only

/* Image identities use the complete archive, independently of active settings.
 * The native BYTE1 storage and all factory/unknown branches stay unchanged. */
#include <stdint.h>
extern const uint8_t crop_image_archive[];

uint32_t crop_image_is_known_custom(uint32_t id) {
    return id >= 4 && id < 256 && crop_image_archive[id];
}

uint32_t crop_image_source_custom(const uint8_t *source) {
    uint32_t id = source[0x7da];
    return crop_image_is_known_custom(id) ? id : 0;
}

uint32_t crop_image_source_aspect(void *dimensions, const uint8_t *source) {
    uint32_t id = crop_image_source_custom(source);
    return id ? id : ((uint32_t (*)(void *))0x536c79ccu)(dimensions);
}

/* These helpers receive only dimensions. The table selects rectangles, never
 * a public identity. Compiler rejects equal dimensions with unequal results. */
typedef struct { uint32_t width, height, screen[4], thumbnail[4]; } ReplayRect;
extern const ReplayRect crop_image_rectangles[];

__attribute__((naked)) static void *native_screen_rect(void *out, void *context,
                                                       const uint32_t *size) {
    __asm__ volatile("mov ip, sp\n b native_screen_rect_body");
}
__attribute__((naked)) static void *native_thumbnail_rect(void *out, void *context,
                                                          const uint32_t *size) {
    __asm__ volatile("mov ip, sp\n b native_thumbnail_rect_body");
}

static const ReplayRect *replay_rectangle(const uint32_t *size) {
    for (unsigned i = 0; i < CROP_REPLAY_RECT_COUNT; ++i) {
        const ReplayRect *r = crop_image_rectangles + i;
        if (r->width == size[0] && r->height == size[1]) return r;
    }
    return 0;
}

void *crop_image_screen_rect(void *out, void *context, const uint32_t *size) {
    const ReplayRect *r = replay_rectangle(size);
    if (!r) return native_screen_rect(out, context, size);
    for (unsigned i = 0; i < 4; ++i) ((uint32_t *)out)[i] = r->screen[i];
    return out;
}

void *crop_image_thumbnail_rect(void *out, void *context, const uint32_t *size) {
    const ReplayRect *r = replay_rectangle(size);
    if (!r) return native_thumbnail_rect(out, context, size);
    for (unsigned i = 0; i < 4; ++i) ((uint32_t *)out)[i] = r->thumbnail[i];
    return out;
}

__attribute__((naked)) void crop_image_extract_gate(void) {
    __asm__ volatile(
        "push {r0-r3, ip, lr}\n bl crop_image_is_known_custom\n"
        "cmp r0, #0\n pop {r0-r3, ip, lr}\n bne 1f\n"
        "cmp r0, #3\n bls native_extract_table\n b native_extract_unknown\n"
        "1: ldr r2, [r4, #12]\n strb r0, [r2, #0x7da]\n b native_extract_return");
}

__attribute__((naked)) void crop_image_set_gate(void) {
    __asm__ volatile(
        "push {r0-r3, ip, lr}\n mov r0, r3\n bl crop_image_is_known_custom\n"
        "cmp r0, #0\n pop {r0-r3, ip, lr}\n bne 1f\n"
        "cmp r3, #3\n bls native_set_table\n b native_set_unknown\n"
        "1: mov r2, r3\n b native_set_join");
}

__attribute__((naked)) void crop_image_playback_gate(void) {
    __asm__ volatile(
        /* This complete playback entry has actual source metadata in r8.
         * Its old dimension classifier cannot itself return a custom ID. */
        "push {r0-r3, ip, lr}\n mov r0, r8\n bl crop_image_source_custom\n"
        "cmp r0, #0\n movne sl, r0\n pop {r0-r3, ip, lr}\n bne 1f\n"
        "push {r0-r3, ip, lr}\n mov r0, sl\n bl crop_image_is_known_custom\n"
        "cmp r0, #0\n pop {r0-r3, ip, lr}\n bne 1f\n"
        "cmp sl, #3\n bls native_playback_table\n b native_playback_unknown\n"
        "1: mov ip, sl\n b native_playback_join");
}

__attribute__((naked)) void crop_image_aspect_gate(void) {
    __asm__ volatile(
        "push {r0-r3, ip, lr}\n bl crop_image_is_known_custom\n"
        "cmp r0, #0\n pop {r0-r3, ip, lr}\n bne native_aspect_return\n"
        "cmp r0, #3\n bls native_aspect_table\n b native_aspect_unknown");
}
