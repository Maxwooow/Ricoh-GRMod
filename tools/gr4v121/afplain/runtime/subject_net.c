/* SPDX-License-Identifier: GPL-2.0-only */
#include "subject_net.h"

/* Layer record: u8 kind, u8 k, u8 stride, u8 zero, u16 cin, u16 cout,
   u8 shift[cout] (padded to 4), i32 bias[cout], i8 weight[...] (padded to 4).
   kind 0: full conv on the RGB input (input value = byte - 128), weight [co][ky][kx][ci]
   kind 1: depthwise, weight [c][ky][kx]      kind 2: 1x1, weight [co][ci] as int16 (same values)
   kind 3: 1x1 to one int32 score per cell (no shift, no clamp), int16 weights; always last.
   The 1x1 layers hold nearly all the arithmetic; 16-bit weights let the ARM build take two
   products per instruction (SMLAD).
   Activations are bytes, rows of pixels of channels.  out = clamp((acc + half) >> shift, 0, 255). */
enum { CONV = 0, DEPTH = 1, POINT = 2, HEAD = 3 };

static uint32_t rd32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static uint32_t rd16(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8; }
static uint32_t pad4(uint32_t n) { return (n + 3u) & ~3u; }

struct layer { uint32_t kind, k, stride, cin, cout; const uint8_t *shift, *bias; const int8_t *w; uint32_t bytes; };

static int layer_at(const uint8_t *p, uint32_t left, struct layer *l) {
  uint32_t wn, need;
  if (left < 8) return 0;
  l->kind = p[0]; l->k = p[1]; l->stride = p[2]; l->cin = rd16(p + 4); l->cout = rd16(p + 6);
  if (p[3] || l->kind > HEAD || !l->cin || !l->cout || l->cin > 1024 || l->cout > 1024) return 0;
  if (l->stride < 1 || l->stride > 4 || !(l->k & 1) || l->k > 7) return 0;
  if (l->kind == CONV) wn = l->cout * l->k * l->k * l->cin;
  else if (l->kind == DEPTH) { if (l->cin != l->cout) return 0; wn = l->cout * l->k * l->k; }
  else { if (l->k != 1 || l->stride != 1) return 0; wn = 2 * l->cout * l->cin; }
  if (l->kind == HEAD && l->cout != 1) return 0;
  need = 8 + pad4(l->cout) + 4 * l->cout + pad4(wn);
  if (left < need) return 0;
  l->shift = p + 8; l->bias = l->shift + pad4(l->cout); l->w = (const int8_t *)(l->bias + 4 * l->cout); l->bytes = need;
  return 1;
}

static uint32_t out_dim(uint32_t in, uint32_t k, uint32_t s) {
  uint32_t n = 0, span = in + 2 * (k / 2);
  if (span < k) return 0;
  span -= k;
  while (span >= s) { span -= s; n++; }      /* (in + 2p - k) / s without a division */
  return n + 1;
}

int subj_check(const uint8_t *m, uint32_t n, struct subj_header *h) {
  uint32_t i, hash = 2166136261u, off = sizeof(struct subj_header), w, hh, c = 3, biggest = 0;
  struct layer l;
  if (!m || !h || n < sizeof(*h)) return SUBJ_BAD_ARGUMENT;
  for (i = 0; i < sizeof(*h) / 4; i++) ((uint32_t *)h)[i] = rd32(m + 4 * i);
  if (h->magic != SUBJ_MAGIC || h->version != SUBJ_VERSION || h->bytes != n) return SUBJ_BAD_MODEL;
  for (i = 0; i < n; i++) { hash ^= (i >= 12 && i < 16) ? 0u : m[i]; hash *= 16777619u; }
  if (hash != h->checksum) return SUBJ_BAD_MODEL;
  if (!h->layers || h->layers > 64 || !h->in_w || !h->in_h || h->in_w > 512 || h->in_h > 512) return SUBJ_BAD_MODEL;
  w = h->in_w; hh = h->in_h;
  for (i = 0; i < h->layers; i++) {
    if (!layer_at(m + off, n - off, &l) || l.cin != c) return SUBJ_BAD_MODEL;
    if ((l.kind == CONV) != (i == 0) || (l.kind == HEAD) != (i == h->layers - 1)) return SUBJ_BAD_MODEL;
    if (l.kind >= POINT && l.cin > SUBJ_MAX_WIDTH) return SUBJ_BAD_MODEL;
    w = out_dim(w, l.k, l.stride); hh = out_dim(hh, l.k, l.stride); c = l.cout; off += l.bytes;
    if (!w || !hh) return SUBJ_BAD_MODEL;
    if (l.kind != HEAD && w * hh * c > biggest) biggest = w * hh * c;
  }
  if (off != n || w != h->grid_w || hh != h->grid_h || w * hh > SUBJ_MAX_GRID || w < 2 || hh < 2) return SUBJ_BAD_MODEL;
  if (h->work_bytes < SUBJ_VECTOR_BYTES + 2 * pad4(biggest) + 4 * w * hh) return SUBJ_BAD_MODEL;
  if (h->step_x_q16 * w > 65536u || h->step_y_q16 * hh > 65536u) return SUBJ_BAD_MODEL;
  return SUBJ_OK;
}

static uint8_t squash(int32_t acc, uint32_t shift) {
  acc = (acc + (int32_t)((1u << shift) >> 1)) >> shift;
  return (uint8_t)(acc < 0 ? 0 : acc > 255 ? 255 : acc);
}

/* The three loops below visit only the kernel taps that fall inside the picture, so the inner
   loops carry no bounds checks.  Sums are exact integers: the order of additions does not matter. */
static void conv_rgb(const struct layer *l, const uint8_t *in, uint32_t iw, uint32_t ih, uint8_t *out, uint32_t ow, uint32_t oh) {
  uint32_t ox, oy, co, k = l->k; int32_t pad = (int32_t)(k / 2), ky, kx;
  for (oy = 0; oy < oh; oy++) {
    int32_t y0 = (int32_t)(oy * l->stride) - pad, ky0 = y0 < 0 ? -y0 : 0, ky1 = (int32_t)ih - y0 < (int32_t)k ? (int32_t)ih - y0 : (int32_t)k;
    for (ox = 0; ox < ow; ox++) {
      int32_t x0 = (int32_t)(ox * l->stride) - pad, kx0 = x0 < 0 ? -x0 : 0, kx1 = (int32_t)iw - x0 < (int32_t)k ? (int32_t)iw - x0 : (int32_t)k;
      for (co = 0; co < l->cout; co++) {
        const int8_t *w = l->w + co * k * k * 3; int32_t acc = (int32_t)rd32(l->bias + 4 * co);
        for (ky = ky0; ky < ky1; ky++) {
          const uint8_t *p = in + 3 * ((uint32_t)(y0 + ky) * iw + (uint32_t)(x0 + kx0)); const int8_t *q = w + 3 * ((uint32_t)ky * k + (uint32_t)kx0);
          for (kx = kx0; kx < kx1; kx++, p += 3, q += 3)
            acc += q[0] * ((int32_t)p[0] - 128) + q[1] * ((int32_t)p[1] - 128) + q[2] * ((int32_t)p[2] - 128);
        }
        *out++ = squash(acc, l->shift[co]);
      }
    }
  }
}

static void depthwise(const struct layer *l, const uint8_t *in, uint32_t iw, uint32_t ih, uint8_t *out, uint32_t ow, uint32_t oh) {
  uint32_t ox, oy, c, k = l->k, ch = l->cout; int32_t pad = (int32_t)(k / 2), ky, kx;
  for (oy = 0; oy < oh; oy++) {
    int32_t y0 = (int32_t)(oy * l->stride) - pad, ky0 = y0 < 0 ? -y0 : 0, ky1 = (int32_t)ih - y0 < (int32_t)k ? (int32_t)ih - y0 : (int32_t)k;
    for (ox = 0; ox < ow; ox++) {
      int32_t x0 = (int32_t)(ox * l->stride) - pad, kx0 = x0 < 0 ? -x0 : 0, kx1 = (int32_t)iw - x0 < (int32_t)k ? (int32_t)iw - x0 : (int32_t)k;
      for (c = 0; c < ch; c++) {
        const int8_t *w = l->w + c * k * k; int32_t acc = (int32_t)rd32(l->bias + 4 * c);
        for (ky = ky0; ky < ky1; ky++) {
          const uint8_t *p = in + ((uint32_t)(y0 + ky) * iw + (uint32_t)(x0 + kx0)) * ch + c; const int8_t *q = w + (uint32_t)ky * k + (uint32_t)kx0;
          for (kx = kx0; kx < kx1; kx++, p += ch) acc += *q++ * (int32_t)*p;
        }
        *out++ = squash(acc, l->shift[c]);
      }
    }
  }
}

typedef uint32_t __attribute__((may_alias)) pair_t;      /* two 16-bit values read as one word */
static void pointwise(const struct layer *l, const uint8_t *in, uint32_t cells, uint8_t *out, int32_t *score, uint16_t *vec) {
  uint32_t i, co, ci, cin = l->cin, pairs = cin >> 1;
  for (i = 0; i < cells; i++, in += cin) {
    const int16_t *w = (const int16_t *)(const void *)l->w;
    for (ci = 0; ci < cin; ci++) vec[ci] = in[ci];
    for (co = 0; co < l->cout; co++, w += cin) {
      int32_t acc = (int32_t)rd32(l->bias + 4 * co);
#if defined(__arm__)
      const pair_t *p = (const pair_t *)(const void *)vec, *q = (const pair_t *)(const void *)w;
      uint32_t n = pairs >> 1, t0, t1;
      if (n) __asm__ volatile(
        "1:\n\tldr %[a], [%[p]], #4\n\tldr %[b], [%[q]], #4\n\tsmlad %[acc], %[a], %[b], %[acc]\n"
        "\tldr %[a], [%[p]], #4\n\tldr %[b], [%[q]], #4\n\tsmlad %[acc], %[a], %[b], %[acc]\n"
        "\tsubs %[n], %[n], #1\n\tbne 1b"
        : [acc] "+r"(acc), [p] "+r"(p), [q] "+r"(q), [n] "+r"(n), [a] "=&r"(t0), [b] "=&r"(t1) : : "cc", "memory");
      if (pairs & 1u) { uint32_t a = p[0], b = q[0]; __asm__("smlad %0, %1, %2, %0" : "+r"(acc) : "r"(a), "r"(b)); }
      ci = 2 * pairs;
#else
      for (ci = 0; ci < 2 * pairs; ci += 2) acc += w[ci] * (int32_t)vec[ci] + w[ci + 1] * (int32_t)vec[ci + 1];
#endif
      if (ci < cin) acc += w[ci] * (int32_t)vec[ci];
      if (score) *score++ = acc; else *out++ = squash(acc, l->shift[co]);
    }
  }
}

/* Luma variance over a coarse lattice, for the blank-frame check. */
static uint32_t luma_variance(const uint8_t *rgb, uint32_t w, uint32_t h) {
  uint32_t i, j, s = 0, s2 = 0, mean;
  for (j = 0; j < 16; j++) for (i = 0; i < 16; i++) {      /* 256 points spread over the whole frame */
    const uint8_t *p = rgb + 3 * ((((2 * j + 1) * h) >> 5) * w + (((2 * i + 1) * w) >> 5));
    uint32_t v = (77u * p[0] + 150u * p[1] + 29u * p[2]) >> 8;
    s += v; s2 += v * v;
  }
  mean = s >> 8;
  return (s2 >> 8) > mean * mean ? (s2 >> 8) - mean * mean : 0;
}

/* Where the score peak sits between cells: offset from the best cell's centre in 1/256 cell,
   -128..128, from a parabola through the cell and its two neighbours. */
static int32_t peak_offset(int32_t lo, int32_t mid, int32_t hi) {
  int32_t num, den, v;
  lo -= mid; hi -= mid;                              /* both <= 0: mid is the maximum */
  while (lo < -16384 || hi < -16384) { lo >>= 1; hi >>= 1; }
  num = lo - hi; den = 2 * (lo + hi);
  if (den >= 0) return 0;
  v = (num * 256) / den;
  return v < -128 ? -128 : v > 128 ? 128 : v;
}

int subj_run(const uint8_t *rgb, const uint8_t *m, uint32_t n, void *work, uint32_t work_bytes, struct subj_result *out) {
  struct subj_header h; struct layer l; struct subj_result r;
  uint32_t i, off = sizeof(h), w, hh, c = 3, half, cells, best = 0, bx, by, x, variance;
  uint8_t *a, *b, *t; const uint8_t *in = rgb; int32_t *score, s, top = 0; uint16_t *vec;
  if (!rgb || !work || !out || ((uintptr_t)work & 3u)) return SUBJ_BAD_ARGUMENT;
  i = (uint32_t)subj_check(m, n, &h);
  if (i) return (int)i;
  if (work_bytes < h.work_bytes) return SUBJ_WORK_TOO_SMALL;
  variance = luma_variance(rgb, h.in_w, h.in_h);
  if (variance < 4) return SUBJ_BLANK;
  /* workspace: one input vector, two activation buffers, the scores */
  cells = h.grid_w * h.grid_h; half = ((h.work_bytes - SUBJ_VECTOR_BYTES - 4 * cells) / 2) & ~3u;
  vec = (uint16_t *)work; a = (uint8_t *)work + SUBJ_VECTOR_BYTES; b = a + half; score = (int32_t *)(void *)(a + 2 * half);
  w = h.in_w; hh = h.in_h;
  for (i = 0; i < h.layers; i++) {
    uint32_t ow, oh;
    layer_at(m + off, n - off, &l); ow = out_dim(w, l.k, l.stride); oh = out_dim(hh, l.k, l.stride);
    if (l.kind == CONV) conv_rgb(&l, in, w, hh, a, ow, oh);
    else if (l.kind == DEPTH) depthwise(&l, in, w, hh, a, ow, oh);
    else pointwise(&l, in, ow * oh, a, l.kind == HEAD ? score : 0, vec);
    in = a; t = a; a = b; b = t; w = ow; hh = oh; c = l.cout; off += l.bytes;
  }
  (void)c;
  for (i = 0; i < cells; i++) if (i == 0 || score[i] > top) { top = score[i]; best = i; }
  by = 0; x = best; while (x >= h.grid_w) { x -= h.grid_w; by++; }
  bx = x;
  r.second_score = top;
  for (i = 0, s = 0; i < cells; i++) if (i != best && (!s || score[i] > r.second_score)) { r.second_score = score[i]; s = 1; }
  /* Box of 1.5 x 1.5 cells centred on the score peak, refined between cells (not at the frame
     edge) and kept inside the frame. */
  {
    int32_t ox = bx > 0 && bx < h.grid_w - 1 ? peak_offset(score[best - 1], top, score[best + 1]) : 0;
    int32_t oy = by > 0 && by < h.grid_h - 1 ? peak_offset(score[best - h.grid_w], top, score[best + h.grid_w]) : 0;
    int32_t cx = (int32_t)((2 * bx + 1) * h.step_x_q16 / 2) + ox * (int32_t)h.step_x_q16 / 256;
    int32_t cy = (int32_t)((2 * by + 1) * h.step_y_q16 / 2) + oy * (int32_t)h.step_y_q16 / 256;
    int32_t bw = (int32_t)(3 * h.step_x_q16 / 2), bh = (int32_t)(3 * h.step_y_q16 / 2);
    int32_t x0 = cx - bw / 2, y0 = cy - bh / 2;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x0 > 65536 - bw) x0 = 65536 - bw;
    if (y0 > 65536 - bh) y0 = 65536 - bh;
    r.x0_q16 = (uint32_t)x0; r.y0_q16 = (uint32_t)y0; r.x1_q16 = (uint32_t)(x0 + bw); r.y1_q16 = (uint32_t)(y0 + bh);
  }
  r.grid_w = h.grid_w; r.grid_h = h.grid_h; r.best_index = best; r.best_score = top;
  r.center_score = score[(h.grid_h >> 1) * h.grid_w + (h.grid_w >> 1)];
  r.luma_variance = variance;
  *out = r;
  return SUBJ_OK;
}
