/* SPDX-License-Identifier: GPL-2.0-only
 *
 * Host test harness for shadowml.c (x86, gcc): shadowml.c is compiled in together with this file into a shared library that
 * test_host.py calls through ctypes. The record P and the blob are exact-size malloc blocks (copies of what the test gives),
 * so a sanitizer sees any overrun, and P is compared afterwards (the module must not write).
 */
#include <stdlib.h>
#include <string.h>
#include "shadowml.c"

/* the firmware's operator new and the RAM word that keeps the scratch pointer: an exact-size malloc block (a sanitizer sees any
 * overrun of a half), kept across calls like in the camera; host_cfg(fail, reset) makes the next allocations fail / forgets the block */
static uptr g_slot; static int g_fail, g_allocs; static void *g_blk;
static void *host_alloc(u32 bytes) { g_allocs++; if (g_fail) return 0; g_blk = malloc(bytes); return g_blk; }
void host_cfg(int fail, int reset) { g_fail = fail; if (reset) { free(g_blk); g_blk = 0; g_slot = 0; g_allocs = 0; } }
int host_allocs(void) { return g_allocs; }
unsigned long long host_slot(void) { return g_slot; }

/* returns the module's result; *same is 1 when P was not modified. F (NF values, or NULL) receives the feature vector of the
 * same call (1 returned in *fok when the grid was usable and a block counted). */
int host_run(const unsigned char *P, unsigned plen, const unsigned char *blob, unsigned bloblen, unsigned magic, unsigned mode,
             unsigned hl, unsigned idx, unsigned period, unsigned *state, int *same, int *F, int *fok) {
  unsigned char *p = malloc(plen ? plen : 1), *orig = malloc(plen ? plen : 1);
  unsigned *b = malloc(bloblen ? ((bloblen + 3) & ~3u) : 4);   /* exact size rounded to the word, as the module reads words */
  struct shadowml_ctx c;
  int r;
  memcpy(p, P, plen); memcpy(orig, P, plen);
  if (bloblen) memcpy(b, blob, bloblen);
  c.magic = magic; c.blob = b; c.blob_len = bloblen; c.period = period; c.state = state; c.alloc = host_alloc; c.slot = &g_slot;
  r = (int)shadowml(&c, p, mode, hl, idx);
  *same = memcmp(p, orig, plen) == 0;
  if (F) {
    struct scratch *sc = malloc(sizeof *sc);   /* (the features are not throttled) */
    *fok = features(p, mode, hl, idx, sc);
    memcpy(F, sc->F, sizeof sc->F);
    if (!*fok) memset(F, 0, sizeof sc->F);
    free(sc);
  }
  free(p); free(orig); free(b);
  return r;
}
