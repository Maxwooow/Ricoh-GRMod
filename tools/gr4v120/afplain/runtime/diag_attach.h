/* SPDX-License-Identifier: GPL-2.0-only */
/* The 1.20 native maker note: reserved vector slots only. */
#ifndef AFT19_DIAG_ATTACH_H
#define AFT19_DIAG_ATTACH_H
#include <stdint.h>
#define AFT19_DIAG_TAG 0xc7a3u
#define AFT19_DIAG_BYTES 96u
enum aft19_attach_result {
 AFT19_APPENDED=1,AFT19_UPDATED=2,
 AFT19_BAD_WIRE=16,AFT19_BAD_MAKER,AFT19_BAD_IFD,AFT19_BAD_VECTOR,
 AFT19_EXISTING_SCHEMA,AFT19_EXISTING_DATA,AFT19_INPUT_ALIAS,
 AFT19_BYTE_CAPACITY,AFT19_VECTOR_FULL,AFT19_POOL_UNAVAILABLE,
 AFT19_ENTRY_OOM,AFT19_PAYLOAD_OOM,AFT19_ADD_FAILED
};
/* Caller owns the 96 encoded bytes for this call. No runtime state/lease is
 * required. Caller checks owner+0x128==owner+0x134 and passes owner+0x124.
 * Unknown/foreign entries, all OEM tags and a full vector remain untouched.
 * A native owner must serialize access to its own IFD as in the stock path. */
/* tag must be 0xc7a3 or 0xc7a2: the two tags the MakerNote setter adapter protects. */
uint32_t aft19_diag_append96_tag(uintptr_t maker,uint32_t byte_capacity,const uint8_t wire[AFT19_DIAG_BYTES],uint32_t tag);
uint32_t aft19_diag_append96(uintptr_t maker,uint32_t byte_capacity,
                            const uint8_t wire[AFT19_DIAG_BYTES]);
#endif
