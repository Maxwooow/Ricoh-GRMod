/* SPDX-License-Identifier: GPL-2.0-only */
/* Subject-pick network: integer-only inference.  No float, no division, no 64-bit, no globals. */
#ifndef SUBJECT_NET_H
#define SUBJECT_NET_H
#include <stdint.h>

#define SUBJ_MAGIC 0x4a425553u /* "SUBJ" */
#define SUBJ_VERSION 2u          /* 2: 1x1 layers store int16 weights */
#define SUBJ_MAX_GRID 128u
#define SUBJ_MAX_WIDTH 256u       /* most input channels of a 1x1 layer */
#define SUBJ_VECTOR_BYTES (2u * SUBJ_MAX_WIDTH)

enum { SUBJ_OK = 0, SUBJ_BAD_ARGUMENT = 1, SUBJ_BAD_MODEL = 2, SUBJ_WORK_TOO_SMALL = 3, SUBJ_BLANK = 4 };

struct subj_header {          /* little endian, 48 bytes */
  uint32_t magic, version, bytes, checksum;   /* FNV-1a over the blob with checksum taken as 0 */
  uint32_t in_w, in_h, grid_w, grid_h;
  uint32_t layers, work_bytes;                /* work_bytes: both activation buffers, the scores, one input vector */
  uint32_t step_x_q16, step_y_q16;            /* 65536 / grid_w, 65536 / grid_h, rounded down */
};

struct subj_result {
  uint32_t grid_w, grid_h, best_index;
  uint32_t x0_q16, y0_q16, x1_q16, y1_q16;    /* half-open box over the visible frame, 65536 = full */
  int32_t best_score, center_score, second_score;
  uint32_t luma_variance;
};

/* rgb: in_w*in_h*3 bytes, RGB888 rows.  work: caller memory, 4-byte aligned, >= header work_bytes.
   Returns SUBJ_OK and fills *out, or an error and leaves *out untouched. */
int subj_run(const uint8_t *rgb, const uint8_t *model, uint32_t model_bytes,
             void *work, uint32_t work_bytes, struct subj_result *out);
/* Header check only (magic, version, size, checksum, layer walk). */
int subj_check(const uint8_t *model, uint32_t model_bytes, struct subj_header *copy);
#endif
