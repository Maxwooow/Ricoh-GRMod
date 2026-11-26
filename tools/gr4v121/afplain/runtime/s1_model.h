/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef GRMOD_S1_MODEL_H
#define GRMOD_S1_MODEL_H
#include <stdint.h>
#define S1_COLS 9u
#define S1_ROWS 7u
#define S1_SAMPLES 6300u
#define S1_FEATURES 29u
#define S1_FRAME_PROVEN 1u
#define S1_RGB888 1u
#define S1_NV12_FULL 2u
#define S1_UYVY_FULL 3u
/* All storage is caller-owned. Pixels/model remain immutable during the call.
 * RGB is sampled in the supplied cropped/oriented frame domain. The binding
 * layer proves ownership, read extent, direction and UI correspondence.
 * Enable defaults to0. Any return other thanS1_APPLY means factory fallback.
 * NV12/UYVY origins must be chroma-aligned (x even; NV12y even); odd crop
 * chroma phases are not represented here. Struct/work/output use normal C
 * aligned storage. Budgets are work limits,not a wall-clock deadline.
 * No clock is called. */
enum {S1_APPLY=0,S1_OFF=1,S1_NO_CHANGE=2,S1_LOW_CONFIDENCE=3,S1_BLANK=4,S1_BUDGET=5,S1_BAD_ARGUMENT=6,S1_BAD_FRAME=7,S1_BAD_MODEL=8};
struct s1_request {
 uint32_t enable,format,frame_flags;
 const uint8_t *pixels;
 uint32_t pixel_bytes,width,height,stride;
 const uint8_t *model;
 uint32_t model_bytes,max_samples,max_tree_steps;
 int32_t min_score_q12,min_gain_q12;
 uint32_t min_global_variance,current_x_q16,current_y_q16;
 const uint8_t *uv;
 uint32_t uv_bytes,uv_stride;
};
struct s1_workspace {int32_t cells[63][5];uint16_t sample_x[90],sample_y[70];};
struct s1_result {
 uint32_t status,index,x_q16,y_q16,ui_x,ui_y;
 int32_t score_q12,current_score_q12,runner_gap_q12;
 uint32_t samples,tree_steps,global_variance;
};
/* BAD_ARGUMENT/OFF/BAD_FRAME/BAD_MODEL/BUDGET do not promise a result write;
 * always inspect the return code first. No camera point is written here. */
int s1_run(const struct s1_request *request,struct s1_workspace *workspace,struct s1_result *result);
/* Collector helper: writes exactly18900 bytes of90x70 row-major RGB888.
 * Caller gates feature enable and proves source lifetime throughout this call.
 * Model fields are ignored. ReturnS1_APPLY only after the sample is complete;
 * publish the caller-owned inactive snapshot slot only after this succeeds. */
int s1_sample_rgb(const struct s1_request *request,uint8_t *rgb,uint32_t capacity);
/* Subject-network thumbnail: w x h RGB888 (3*w*h bytes), each pixel the mean of 2x2 source
 * samples; tab is 2*(w+h) entries of caller scratch.  Same frame checks as s1_sample_rgb. */
int s1_sample_thumb(const struct s1_request *request,uint8_t *rgb,uint32_t w,uint32_t h,uint16_t *tab);
/* Offline diagnosis entry: same canonical sampler/features,63x29 caller output.
 * Model and enable are ignored; frame and storage bounds are still checked. */
int s1_debug_features(const struct s1_request *request,struct s1_workspace *workspace,int32_t *features);
#endif
