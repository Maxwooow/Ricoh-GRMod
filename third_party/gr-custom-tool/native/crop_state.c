// Copyright (C) 2026 DoYitNow
// SPDX-License-Identifier: GPL-2.0-only

/* Crop selection recovery and archived source geometry. Original UserData and
 * ten snapshots retain the native 2793-byte layout and one-byte identities. */
#include <stdint.h>
extern const uint8_t crop_active_bitmap[];
typedef struct { uint32_t public_id, mag_bits, rectangle[4]; } CropRect;
extern const CropRect crop_source_rectangles[];
#define CURRENT ((uint8_t *(*)(void))0x5323F018u)

uint32_t crop_is_active(uint32_t id) {
    return id < 256 && crop_active_bitmap[id];
}

void crop_normalize_userdata(uint8_t *p) {
    if (p && !crop_is_active(p[0x49f])) p[0x49f] = 0;
}

void crop_normalize_snapshot(uint8_t *p) {
    if (p && !crop_is_active(p[0x49b])) p[0x49b] = 0;
}

void crop_normalize_mode(uint8_t *mode) {
    uint8_t **snapshots = (uint8_t **)(mode + 4);
    for (unsigned i = 0; i < 10; ++i)
        crop_normalize_snapshot(snapshots[i]);
}

extern uint32_t prior_native_save(uint8_t *mode);
extern uint32_t prior_native_load(uint8_t *mode, uint8_t *current,
                                    void *a2, void *a3);

uint32_t crop_state_save(uint8_t *mode) {
    crop_normalize_userdata(CURRENT());
    crop_normalize_mode(mode);
    return prior_native_save(mode);
}

uint32_t crop_state_load(uint8_t *mode, uint8_t *current, void *a2, void *a3) {
    uint32_t result = prior_native_load(mode, current, a2, a3);
    crop_normalize_snapshot(current);
    crop_normalize_mode(mode);
    crop_normalize_userdata(CURRENT());
    return result;
}

/* The displaced native entry sets the frame input. Its unmodified body keeps
 * all four factory identities and unsupported-magnification behavior. */
__attribute__((naked)) static void factory_source_rectangle(void *extractor) {
    __asm__ volatile("mov ip, sp\n b factory_source_rectangle_body");
}

void crop_metadata_rectangle(uint8_t *extractor) {
    uint8_t *source = *(uint8_t **)(extractor + 8);
    uint32_t id = source[0x7da];
    if (id < 4) {
        factory_source_rectangle(extractor);
        return;
    }
    uint32_t mag = *(uint32_t *)(source + 0x7dc);
    for (unsigned i = 0; i < CROP_RECT_COUNT; ++i) {
        const CropRect *r = crop_source_rectangles + i;
        if (r->public_id == id && r->mag_bits == mag) {
            uint32_t *target = (uint32_t *)(source + 0x6c0);
            for (unsigned n = 0; n < 4; ++n)
                target[n] = r->rectangle[n];
            return;
        }
    }
    /* An unknown historical image is not a current setting. Keep the original
     * no-write behavior; never replace its source identity or existing ROI. */
}
