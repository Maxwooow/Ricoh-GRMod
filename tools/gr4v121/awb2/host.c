/* Host build of awb2.c for the tests: the stats pointers in S are offsets into awb2_host_base. */
#define AWB2_HOST
#include <stdlib.h>
const unsigned char *awb2_host_base;
#include "awb2.c"
static void *slot_word;
static void *host_alloc(u32 n) { return calloc(1, n); }
struct awb2_ctx host_ctx;
void host_init(const u32 *lnm, const i32 *ff, const i32 *bias, const i32 *tw, const i16 *th, const u32 *exp2n, const u32 *at, const i32 *cs20, const u32 *rc) {
  host_ctx.magic = AWB2_MAGIC; host_ctx.alloc = host_alloc; host_ctx.slot = &slot_word;
  { static const u32 fm_word = 1; static const u8 wait_byte = 0; host_ctx.flash_mgr = &fm_word; host_ctx.seq_wait = &wait_byte; }   /* not read: the host build takes awb2_host_fm / awb2_host_wait */
  host_ctx.lnm = lnm; host_ctx.ff = ff; host_ctx.bias = bias; host_ctx.tw = tw; host_ctx.tanh = th; host_ctx.exp2n = exp2n; host_ctx.atan = at; host_ctx.cs20 = cs20; host_ctx.rc = rc;
}
void host_reset(void) { free(slot_word); slot_word = 0; }
void host_call(const unsigned char *base, unsigned char *obj, const unsigned char *S, int still) { awb2_host_base = base; awb2(&host_ctx, obj, S, still ? (void *)1 : 0); }
/* state peek: have, mu[2], sg[2] */
int host_state(int *mu, unsigned *sg) { struct awb2_state *st = slot_word; if (!st || !st->have) return 0; mu[0] = st->mu[0]; mu[1] = st->mu[1]; sg[0] = st->sg[0]; sg[1] = st->sg[1]; return 1; }
/* the flash data manager's type (+0x14) and the shooting sequence's "still waiting for the charge" byte; a negative type: no manager */
const unsigned char *awb2_host_fm;
unsigned char awb2_host_wait;
static unsigned char fm_obj[0x90];
void host_set_flash(int type, int waiting) { awb2_host_wait = (unsigned char)waiting; if (type < 0) { awb2_host_fm = 0; return; } fm_obj[0x14] = (unsigned char)type; awb2_host_fm = fm_obj; }
/* the diagnostic record (AWB2_DIAG_SIZE bytes) */
int host_diag(unsigned char *out) { unsigned i; if (!slot_word) return 0; for (i = 0; i < AWB2_DIAG_SIZE; i++) out[i] = ((const unsigned char *)slot_word)[i]; return AWB2_DIAG_SIZE; }
/* single-frame observation, for the comparison with the float reference */
int host_observe(const unsigned char *base, const unsigned char *S, int has_exp, int e30, int *z, unsigned *r) {
  awb2_host_base = base;
  if (!slot_word) slot_word = calloc(2, sizeof(struct awb2_state));
  if (!observe_a(&host_ctx, slot_word, S, 0)) return 0;
  observe_b(&host_ctx, slot_word, (u32)has_exp, e30, z, r);
  return 1;
}
