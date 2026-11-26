/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef GRMOD_AFPLAIN_RUNTIME_H
#define GRMOD_AFPLAIN_RUNTIME_H
#include <stdint.h>
#include <stddef.h>
#define S1_MODULE_MAGIC 0x31464741u
/* Same appended 80-byte context as the earlier builds (the packer is shared).
 * Used here: enabled, state_word, model, model_bytes, the three model budgets,
 * reserved[0] = native getter trampoline, reserved[1] bit1 = sound cue on. */
struct s1_module_ctx {
 uint32_t magic,enabled; volatile uint32_t *state_word;
 const uint8_t *model; uint32_t model_bytes;const char *event_name;
 uint32_t wait_units,max_samples,max_tree_steps;
 int32_t min_score_q12,min_gain_q12;uint32_t min_global_variance;
 uint8_t model_sha_prefix[8];uint32_t reserved[2];char name_storage[16];
};
/* Hook numbers are the adapter template numbers of the earlier builds. Only
 * these seven are installed. */
enum { PL_OP_RUN=1,PL_OP_COLLECT=2,PL_OP_JPEG=5,PL_OP_DNG=6,PL_OP_SET_PRIVATE=7,PL_OP_GETTER=8,PL_OP_AF_END=12,PL_OP_SOUND=26 };
uint32_t af_s1_dispatch(uint32_t,uintptr_t,uintptr_t,const struct s1_module_ctx*);
#endif
