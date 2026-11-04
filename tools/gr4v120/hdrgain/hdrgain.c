// SPDX-License-Identifier: GPL-2.0-only
/*
 * HDR gain map for the GR IV's JPEGs (GR Mod, firmware 1.20, ported from 1.11; the module is the same code). See core/src/fw/gr4v120/aspect/hdrgain.ts.
 *
 * Three entries, one function (hdrgain), chosen by `op`:
 *
 *  OP_POST (after JpegEncodeMacroProcess::Execute has encoded a picture; a = its configuration):
 *    finds the main stream among the encoder's output descriptors (the one that starts with DQT
 *    and whose SOF has the size of one of the configuration's pictures), takes a fingerprint of
 *    it, makes a gain map of a quarter of the picture's size from that picture's Y plane (average
 *    of 4 x 4 pixels through a table: how far above the highlights' start, in 0..255), encodes it
 *    as a greyscale baseline JPEG with the gain-map metadata, and keeps it under the fingerprint.
 *
 *  OP_COUNT (ExifJpegWriter::GetWriteBlockCount; a = the writer): when the writer's main stream
 *    has the fingerprint of a kept gain map, the file is written as 4 blocks (the camera's header,
 *    our segments: XMP, ISO 21496-1 version, MPF [, diagnostics], the camera's main stream, the gain
 *    map); otherwise 2 (as the camera) or, in diagnostic builds with a sane layout, 3 (header, the
 *    diagnostics segment, main stream).
 *
 *  OP_INFO (ExifJpegWriter::GetWriteBlockInfo; a = the writer, b = block): a block of ours, or 0
 *    (the stub then calls the camera's own function).
 *
 *  Diagnostic builds (flags bit 0) also: the stubs count their calls in two words before the heap
 *  (`counters`: [0] low half Execute entries, high half Execute returns; [1] low half block counts,
 *  high half block infos); GetWriteBlockCount makes the state itself when the encode step never
 *  did (or the state word holds something else); and every file that would be written as the
 *  camera's two blocks gets a third, after the camera's EOI: "GRMODHDT" and the counters (the
 *  camera's blocks are not changed).
 *
 * Position independent, no global data: everything comes through the context. The state (kept
 * gain maps, writers, diagnostics) is allocated on the heap the first time a picture is encoded
 * and its address kept in one word before the heap. Pictures, streams and the writer's blocks
 * are checked before use; anything unexpected leaves the camera's own file as it is.
 */

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int s32;
typedef unsigned long long u64;

#define OP_POST 1
#define OP_COUNT 2
#define OP_INFO 3

/* A picture as the image pipeline describes it (0x20 bytes; as in tools/gr4v120/datestamp/datestamp.c). */
struct picture {
  u8 format;          /* 1: YCbCr 4:2:2 */
  u8 pad[3];
  u8 *y;
  u8 *c;
  u32 size;
  u16 width, height, stride, c_height;
  u16 x, y_off;
  u8 tail[4];
};

struct ctx {
  void (*flush)(u32 addr, u32 n);   /* 0x53000930: clean and invalidate data cache lines (64 bytes) */
  void *(*alloc)(u32 n);            /* 0x539084bc */
  void (*free)(void *p);            /* 0x539084f8 */
  void *volatile *state;            /* a zero-filled word before the heap */
  const u8 *code;                   /* 256: average Y of 4 x 4 pixels -> gain map value */
  const u8 *zigzag;                 /* 64: natural index of the k-th coefficient in zigzag order */
  const u32 *recip;                 /* 64, natural order: (2^20 + d/2) / d, d = 8 x quantiser */
  const u16 *half;                  /* 64, natural order: d / 2 */
  const u32 *dc;                    /* 12: code | length << 16 */
  const u32 *ac;                    /* 256: code | length << 16 */
  const u8 *gm_head;                /* gain map JPEG from SOI to the end of SOS */
  u32 gm_head_len;
  u32 gm_sof;                       /* offset of SOF's height in gm_head */
  const u8 *xmp_pre;                /* primary XMP payload before the gain map's length (digits) */
  u32 xmp_pre_len;
  const u8 *xmp_post;               /* ... and after it */
  u32 xmp_post_len;
  const u8 *iso;                    /* primary ISO 21496-1 version segment, from FF E2 */
  u32 iso_len;
  u32 flags;                        /* bit 0: diagnostics segment */
  u32 magic;                        /* 'HDR1' */
  volatile u32 *counters;           /* diagnostic builds: two words the stubs count in (0: none) */
};

#define FLAG_DIAG 1u

#define NE 8                /* gain maps kept */
#define NW 4                /* writers known */
#define SEG_MAX 1536
#define OUT_CAP (384u << 10)
#define HOLD_MAX (1024u << 10)  /* most bytes of gain maps kept at a time */
#define FP_OFF 1024u        /* fingerprint: FP_LEN bytes from FP_OFF of the main stream */
#define FP_LEN 16384u
#define STREAM_MIN (FP_OFF + FP_LEN + 2u)
#define STREAM_MAX 0x08000000u
#define STATE_MAGIC 0x31524448u   /* 'HDR1' */
#define NDIAG 96
#define DIAG_VERSION 2

struct entry {
  u32 used, seq, fp, dims;          /* dims = width | height << 16 */
  u8 *gm;
  u32 gm_len;
  u32 pins;                         /* writers that use it */
  u32 done;                         /* a writer has gone on to another file: given up at the next picture */
};

struct wslot {
  const u8 *self;
  u32 use, n;
  struct entry *e;
  u32 blocks[12];
  u32 seg_len;
  u8 seg[SEG_MAX];
  u8 tail[16 + 4 * NDIAG];          /* diagnostic builds: the block after the camera's EOI */
};

/* Diagnostics (words; written into the diagnostics segment of each file in diagnostic builds). */
enum {
  D_POST_CALLS, D_POST_OK, D_POST_REASON, D_POST_DIMS, D_POST_STREAM, D_POST_SLEN, D_POST_GMLEN, D_POST_FP,
  D_CFG,                         /* 10 words: config 0x38..0x5c */
  D_CAND = D_CFG + 10,           /* 4 x 3 words: descriptor, its [0], its [3] */
  D_W_CALLS = D_CAND + 12, D_W_MATCH, D_W_REASON, D_W_FP, D_W_DIMS, D_W_M, D_SEQ, D_KEPT,
  /* version 2 */
  D_EXEC, D_CNT,                 /* the stubs' counters (see `counters`) */
  D_STATE_RAW,                   /* what the state word held when the state was made */
  D_STATE_BY,                    /* 1: the encode step made the state, 2: the block count */
  D_STATE_AT,                    /* the state's address */
  D_LOCK_FAIL,                   /* times the lock was not got */
  D_TAILS,                       /* files given the block after the camera's EOI */
  D_W_SELF, D_W_VT,              /* the writer, its vtable */
  D_W_RAW,                       /* 21 words: the writer at +0x40..+0x90 (blocks at +0x54) */
  D_END = D_W_RAW + 21
};

struct state {
  u32 magic;
  volatile u32 lock;
  u32 seq, use;
  struct entry e[NE];
  struct wslot w[NW];
  u32 d[NDIAG];
};

static void post(const struct ctx *k, u32 *config);
static u32 count(const struct ctx *k, const u8 *self);
static u32 info(const struct ctx *k, const u8 *self, u32 i);

/* The entry (first in .text). */
u32 hdrgain(const struct ctx *k, u32 op, u32 a, u32 b) {
  if (op == OP_POST) { post(k, (u32 *)a); return 0; }
  if (op == OP_COUNT) return count(k, (const u8 *)a);
  if (op == OP_INFO) return info(k, (const u8 *)a, b);
  return 0;
}

/* ---------------------------------------------------------------- helpers */

static int ram(const void *p) {
  u32 a = (u32)p;
  return a >= 0x40000000u && a < 0xc0000000u;
}

static void copy(u8 *d, const u8 *s, u32 n) {
  u32 i;
  for (i = 0; i < n; i++) d[i] = s[i];
}

static void zero(u32 *d, u32 words) {
  u32 i;
  for (i = 0; i < words; i++) d[i] = 0;
}

static u32 be16(const u8 *p) { return (u32)p[0] << 8 | p[1]; }

static void put16(u8 *p, u32 v) { p[0] = (u8)(v >> 8); p[1] = (u8)v; }
static void put32(u8 *p, u32 v) { p[0] = (u8)(v >> 24); p[1] = (u8)(v >> 16); p[2] = (u8)(v >> 8); p[3] = (u8)v; }
static void put32le(u8 *p, u32 v) { p[0] = (u8)v; p[1] = (u8)(v >> 8); p[2] = (u8)(v >> 16); p[3] = (u8)(v >> 24); }

static void flush(const struct ctx *k, const void *p, u32 n) {
  u32 a = (u32)p & ~63u, e = ((u32)p + n + 63u) & ~63u;
  k->flush(a, e - a);
}

static int lock(struct state *s) {
  u32 tries;
  for (tries = 0; tries < (1u << 20); tries++) {
    if (__builtin_arm_ldrex(&s->lock) == 0) {
      if (__builtin_arm_strex(1u, &s->lock) == 0) {
        __builtin_arm_dmb(11);
        return 1;
      }
    } else {
      __builtin_arm_clrex();
    }
  }
  s->d[D_LOCK_FAIL]++;
  return 0;
}

static void unlock(struct state *s) {
  __builtin_arm_dmb(11);
  s->lock = 0;
}

/* Fingerprint of a main stream: FNV-1a over FP_LEN bytes from FP_OFF, word by word, with the size. */
static u32 fingerprint(const u8 *st, u32 dims) {
  const u8 *p = st + FP_OFF;
  u32 h = 2166136261u ^ dims, i;
  for (i = 0; i < FP_LEN; i += 4) {
    u32 w = (u32)p[i] | (u32)p[i + 1] << 8 | (u32)p[i + 2] << 16 | (u32)p[i + 3] << 24;
    h = (h ^ w) * 16777619u;
  }
  return h;
}

/* A camera main stream: DQT first, then segments up to SOS within `limit` bytes; the SOF's size. */
static u32 stream_dims(const u8 *st, u32 limit) {
  u32 i = 0, dims = 0;
  if (st[0] != 0xff || st[1] != 0xdb) return 0;
  while (i + 4 <= limit) {
    u32 m, len;
    if (st[i] != 0xff) return 0;
    m = st[i + 1];
    len = be16(st + i + 2);
    if (len < 2 || i + 2 + len > limit) return 0;
    if (m == 0xc0 || m == 0xc1 || m == 0xc2) {
      u32 h, w;
      if (len < 8) return 0;
      h = be16(st + i + 5); w = be16(st + i + 7);
      if (w < 64 || h < 64) return 0;
      dims = w | h << 16;
    }
    if (m == 0xda) return dims;
    i += 2 + len;
  }
  return 0;
}

static int picture_ok(const struct picture *p) {
  u32 w = p->width, h = p->height;
  if (p->format != 1) return 0;
  if (!ram(p->y) || !ram(p->c)) return 0;
  if (w < 64 || h < 64 || w > 12000 || h > 12000) return 0;
  if (p->stride < w) return 0;
  return 1;
}

/* The state; `create`: 1 the encode step, 2 the block count (diagnostic builds). Diagnostic builds
 * also take the word over when it holds something that is not a state (it is ours alone). */
static struct state *get_state(const struct ctx *k, int create) {
  struct state *s = (struct state *)*k->state;
  u32 raw = (u32)s;
  if (s) {
    if (ram(s) && !((u32)s & 3u) && s->magic == STATE_MAGIC) return s;
    if (!(k->flags & FLAG_DIAG)) return 0;
  }
  if (!create) return 0;
  s = (struct state *)k->alloc(sizeof(struct state));
  if (!s || !ram(s) || ((u32)s & 3u)) return 0;
  zero((u32 *)s, sizeof(struct state) / 4);
  s->magic = STATE_MAGIC;
  s->d[D_STATE_RAW] = raw;
  s->d[D_STATE_BY] = (u32)create;
  s->d[D_STATE_AT] = (u32)s;
  *k->state = s;
  return s;
}

/* ---------------------------------------------------------------- JPEG encoder (greyscale, baseline) */

struct bits {
  u8 *out;
  u32 pos, cap;
  u32 acc, n;
  int over;
};

static void emit_byte(struct bits *b, u32 v) {
  if (b->pos + 1 >= b->cap) { b->over = 1; return; }
  b->out[b->pos++] = (u8)v;
  if (v == 0xff) {
    if (b->pos + 1 >= b->cap) { b->over = 1; return; }
    b->out[b->pos++] = 0;
  }
}

static void put_bits(struct bits *b, u32 code, u32 len) {
  if (!len) return;
  b->acc = (b->acc << len) | (code & ((1u << len) - 1u));
  b->n += len;
  while (b->n >= 8) {
    b->n -= 8;
    emit_byte(b, (b->acc >> b->n) & 0xffu);
  }
  b->acc &= (1u << b->n) - 1u;
}

static void flush_bits(struct bits *b) {
  if (b->n) put_bits(b, 0x7fu, 8 - b->n);
}

static u32 nbits(u32 v) { return v ? 32u - (u32)__builtin_clz(v) : 0; }

/* libjpeg's jfdctint (LL&M, CONST_BITS 13, PASS1_BITS 2): output is 8 x the DCT. */
#define FIX_0_298631336 2446
#define FIX_0_390180644 3196
#define FIX_0_541196100 4433
#define FIX_0_765366865 6270
#define FIX_0_899976223 7373
#define FIX_1_175875602 9633
#define FIX_1_501321110 12299
#define FIX_1_847759065 15137
#define FIX_1_961570560 16069
#define FIX_2_053119869 16819
#define FIX_2_562915447 20995
#define FIX_3_072711026 25172
#define DESCALE(x, n) (((x) + (1 << ((n) - 1))) >> (n))

static void fdct(s32 *d) {
  s32 t0, t1, t2, t3, t4, t5, t6, t7, t10, t11, t12, t13, z1, z2, z3, z4, z5;
  s32 *p;
  int i;
  for (p = d, i = 0; i < 8; i++, p += 8) {
    t0 = p[0] + p[7]; t7 = p[0] - p[7];
    t1 = p[1] + p[6]; t6 = p[1] - p[6];
    t2 = p[2] + p[5]; t5 = p[2] - p[5];
    t3 = p[3] + p[4]; t4 = p[3] - p[4];
    t10 = t0 + t3; t13 = t0 - t3; t11 = t1 + t2; t12 = t1 - t2;
    p[0] = (t10 + t11) << 2;
    p[4] = (t10 - t11) << 2;
    z1 = (t12 + t13) * FIX_0_541196100;
    p[2] = DESCALE(z1 + t13 * FIX_0_765366865, 11);
    p[6] = DESCALE(z1 + t12 * -FIX_1_847759065, 11);
    z1 = t4 + t7; z2 = t5 + t6; z3 = t4 + t6; z4 = t5 + t7;
    z5 = (z3 + z4) * FIX_1_175875602;
    t4 = t4 * FIX_0_298631336; t5 = t5 * FIX_2_053119869; t6 = t6 * FIX_3_072711026; t7 = t7 * FIX_1_501321110;
    z1 = z1 * -FIX_0_899976223; z2 = z2 * -FIX_2_562915447; z3 = z3 * -FIX_1_961570560; z4 = z4 * -FIX_0_390180644;
    z3 += z5; z4 += z5;
    p[7] = DESCALE(t4 + z1 + z3, 11);
    p[5] = DESCALE(t5 + z2 + z4, 11);
    p[3] = DESCALE(t6 + z2 + z3, 11);
    p[1] = DESCALE(t7 + z1 + z4, 11);
  }
  for (p = d, i = 0; i < 8; i++, p++) {
    t0 = p[0] + p[56]; t7 = p[0] - p[56];
    t1 = p[8] + p[48]; t6 = p[8] - p[48];
    t2 = p[16] + p[40]; t5 = p[16] - p[40];
    t3 = p[24] + p[32]; t4 = p[24] - p[32];
    t10 = t0 + t3; t13 = t0 - t3; t11 = t1 + t2; t12 = t1 - t2;
    p[0] = DESCALE(t10 + t11, 2);
    p[32] = DESCALE(t10 - t11, 2);
    z1 = (t12 + t13) * FIX_0_541196100;
    p[16] = DESCALE(z1 + t13 * FIX_0_765366865, 15);
    p[48] = DESCALE(z1 + t12 * -FIX_1_847759065, 15);
    z1 = t4 + t7; z2 = t5 + t6; z3 = t4 + t6; z4 = t5 + t7;
    z5 = (z3 + z4) * FIX_1_175875602;
    t4 = t4 * FIX_0_298631336; t5 = t5 * FIX_2_053119869; t6 = t6 * FIX_3_072711026; t7 = t7 * FIX_1_501321110;
    z1 = z1 * -FIX_0_899976223; z2 = z2 * -FIX_2_562915447; z3 = z3 * -FIX_1_961570560; z4 = z4 * -FIX_0_390180644;
    z3 += z5; z4 += z5;
    p[56] = DESCALE(t4 + z1 + z3, 15);
    p[40] = DESCALE(t5 + z2 + z4, 15);
    p[24] = DESCALE(t6 + z2 + z3, 15);
    p[8] = DESCALE(t7 + z1 + z4, 15);
  }
}

static void block(const struct ctx *k, struct bits *b, const u8 *src, u32 pitch, s32 *prev) {
  s32 d[64];
  u32 i, j, run;
  s32 q[64];
  for (i = 0; i < 8; i++)
    for (j = 0; j < 8; j++) d[i * 8 + j] = (s32)src[i * pitch + j] - 128;
  fdct(d);
  for (i = 0; i < 64; i++) {
    s32 v = d[i];
    u32 a = (u32)(v < 0 ? -v : v);
    u32 r = (u32)(((u64)(a + k->half[i]) * k->recip[i]) >> 20);
    q[i] = v < 0 ? -(s32)r : (s32)r;
  }
  {
    s32 diff = q[0] - *prev;
    u32 a = (u32)(diff < 0 ? -diff : diff), n = nbits(a);
    *prev = q[0];
    put_bits(b, k->dc[n] & 0xffffu, k->dc[n] >> 16);
    if (n) put_bits(b, diff < 0 ? (u32)(diff - 1) : (u32)diff, n);
  }
  run = 0;
  for (i = 1; i < 64; i++) {
    s32 v = q[k->zigzag[i]];
    u32 a, n, sym;
    if (!v) { run++; continue; }
    while (run > 15) { put_bits(b, k->ac[0xf0] & 0xffffu, k->ac[0xf0] >> 16); run -= 16; }
    a = (u32)(v < 0 ? -v : v);
    if (a > 1023u) { a = 1023u; v = v < 0 ? -1023 : 1023; }
    n = nbits(a);
    sym = run << 4 | n;
    put_bits(b, k->ac[sym] & 0xffffu, k->ac[sym] >> 16);
    put_bits(b, v < 0 ? (u32)(v - 1) : (u32)v, n);
    run = 0;
  }
  if (run) put_bits(b, k->ac[0] & 0xffffu, k->ac[0] >> 16);
}

/* One row of the gain map: the average Y of each 4 x 4 block (edges repeated) through the table. */
static void map_row(const struct ctx *k, const struct picture *p, u32 gy, u8 *row, u32 gw, int aligned) {
  u32 W = p->width, H = p->height, S = p->stride, x, r;
  const u8 *r0, *r1, *r2, *r3, *code = k->code;
  const u8 *rows[4];
  for (r = 0; r < 4; r++) {
    u32 y = gy * 4 + r;
    if (y >= H) y = H - 1;
    rows[r] = p->y + y * S;
  }
  r0 = rows[0]; r1 = rows[1]; r2 = rows[2]; r3 = rows[3];
  x = 0;
  if (aligned) {
    const u32 *q0 = (const u32 *)r0, *q1 = (const u32 *)r1, *q2 = (const u32 *)r2, *q3 = (const u32 *)r3;
    u32 full = W >> 2;
    if (full > gw) full = gw;
    for (; x < full; x++) {
      u32 a = q0[x], b = q1[x], c = q2[x], d = q3[x], acc;
      acc = (a & 0x00ff00ffu) + ((a >> 8) & 0x00ff00ffu) + (b & 0x00ff00ffu) + ((b >> 8) & 0x00ff00ffu)
          + (c & 0x00ff00ffu) + ((c >> 8) & 0x00ff00ffu) + (d & 0x00ff00ffu) + ((d >> 8) & 0x00ff00ffu);
      row[x] = code[((acc & 0xffffu) + (acc >> 16) + 8) >> 4];
    }
  }
  for (; x < gw; x++) {
    u32 xa = x * 4, sum = 0, c;
    for (r = 0; r < 4; r++)
      for (c = 0; c < 4; c++) {
        u32 xx = xa + c;
        if (xx >= W) xx = W - 1;
        sum += rows[r][xx];
      }
    row[x] = code[(sum + 8) >> 4];
  }
}

/* The gain map as a JPEG into out (cap bytes): its length, 0 when it did not fit or memory ran out. */
static u32 encode(const struct ctx *k, const struct picture *p, u8 *out, u32 cap) {
  u32 W = p->width, H = p->height, gw = (W + 3) >> 2, gh = (H + 3) >> 2, bw = (gw + 7) & ~7u, gy, x, r;
  int aligned = (((u32)p->y | p->stride) & 3u) == 0;
  struct bits b;
  s32 prev = 0;
  u8 *strip;
  if (k->gm_head_len + 16 > cap) return 0;
  strip = (u8 *)k->alloc(bw * 8 + 8);
  if (!strip) return 0;
  copy(out, k->gm_head, k->gm_head_len);
  put16(out + k->gm_sof, gh);
  put16(out + k->gm_sof + 2, gw);
  b.out = out; b.pos = k->gm_head_len; b.cap = cap - 2; b.acc = 0; b.n = 0; b.over = 0;
  for (gy = 0; gy < gh && !b.over; gy += 8) {
    u32 y0 = gy * 4, y1 = (gy + 8) * 4;
    if (y1 > H) y1 = H;
    flush(k, p->y + y0 * p->stride, (y1 - y0) * p->stride);
    for (r = 0; r < 8; r++) {
      u8 *row = strip + r * bw;
      if (gy + r < gh) map_row(k, p, gy + r, row, gw, aligned);
      else copy(row, strip + (r - 1) * bw, gw);
      for (x = gw; x < bw; x++) row[x] = row[gw - 1];
    }
    for (x = 0; x < bw; x += 8) block(k, &b, strip + x, bw, &prev);
  }
  k->free(strip);
  if (b.over) return 0;
  flush_bits(&b);
  if (b.over || b.pos + 2 > cap) return 0;
  out[b.pos++] = 0xff;
  out[b.pos++] = 0xd9;
  return b.pos;
}

/* ---------------------------------------------------------------- after the encoder */

static void post(const struct ctx *k, u32 *config) {
  struct state *s = get_state(k, 1);
  struct picture *p = 0;
  u8 *st = 0, *out, *gm, *old = 0;
  u32 slen = 0, dims = 0, fp, n, i, nv = 0;
  u8 *victims[NE];
  struct entry *e = 0;
  if (!s) return;
  s->d[D_POST_CALLS]++;
  s->d[D_POST_REASON] = 1;
  /* Gain maps whose file has been written (its writer went on to another one): given up. */
  {
    u8 *gone[NE];
    u32 ng = 0;
    if (lock(s)) {
      for (i = 0; i < NE; i++) {
        struct entry *c = &s->e[i];
        if (c->used && c->done && !c->pins) { gone[ng++] = c->gm; c->used = 0; c->gm = 0; c->done = 0; }
      }
      unlock(s);
    }
    for (i = 0; i < ng; i++) k->free(gone[i]);
  }
  if (!ram(config) || ((u32)config & 3u)) { s->d[D_POST_REASON] = 2; return; }
  for (i = 0; i < 10; i++) s->d[D_CFG + i] = config[(0x38 >> 2) + i];
  for (i = 0; i < 4; i++) {
    const u32 *d = (const u32 *)config[((0x5450584cu >> (8 * i)) & 0xffu) >> 2];
    u8 *a;
    u32 len, dd;
    s->d[D_CAND + 3 * i] = (u32)d;
    s->d[D_CAND + 3 * i + 1] = 0;
    s->d[D_CAND + 3 * i + 2] = 0;
    if (!ram(d) || ((u32)d & 3u)) continue;
    a = (u8 *)d[0];
    len = d[3];
    s->d[D_CAND + 3 * i + 1] = (u32)a;
    s->d[D_CAND + 3 * i + 2] = len;
    if (st || !ram(a) || !ram(a + len) || len < STREAM_MIN || len > STREAM_MAX) continue;
    flush(k, a, 1024);
    dd = stream_dims(a, 1024);
    if (!dd) continue;
    st = a; slen = len; dims = dd;
  }
  if (!st) { s->d[D_POST_REASON] = 3; return; }
  s->d[D_POST_DIMS] = dims;
  s->d[D_POST_STREAM] = (u32)st;
  s->d[D_POST_SLEN] = slen;
  for (i = 0; i < 4; i++) {
    struct picture *q = (struct picture *)config[(0x3c >> 2) + i];
    if (!ram(q) || ((u32)q & 3u) || !picture_ok(q)) continue;
    if ((q->width | (u32)q->height << 16) == dims) { p = q; break; }
  }
  if (!p) { s->d[D_POST_REASON] = 4; return; }
  flush(k, st + FP_OFF, FP_LEN);
  fp = fingerprint(st, dims);
  flush(k, st + FP_OFF, FP_LEN);
  s->d[D_POST_FP] = fp;
  out = (u8 *)k->alloc(OUT_CAP);
  if (!out) { s->d[D_POST_REASON] = 6; return; }
  n = encode(k, p, out, OUT_CAP);
  if (!n) { k->free(out); s->d[D_POST_REASON] = 7; return; }
  gm = (u8 *)k->alloc(n + 4);
  if (!gm) { k->free(out); s->d[D_POST_REASON] = 8; return; }
  copy(gm, out, n);
  k->free(out);
  if (!lock(s)) { k->free(gm); s->d[D_POST_REASON] = 9; return; }
  /* Keep at most HOLD_MAX bytes: give up the oldest gain maps no writer uses. */
  {
    u32 held = n;
    for (i = 0; i < NE; i++) if (s->e[i].used) held += s->e[i].gm_len;
    while (held > HOLD_MAX) {
      struct entry *c = 0;
      for (i = 0; i < NE; i++) {
        struct entry *x = &s->e[i];
        if (x->used && !x->pins && (!c || x->seq < c->seq)) c = x;
      }
      if (!c) break;
      held -= c->gm_len;
      victims[nv++] = c->gm;
      c->used = 0; c->gm = 0; c->done = 0;
    }
  }
  for (i = 0; i < NE; i++) if (!s->e[i].used) { e = &s->e[i]; break; }
  if (!e) {
    for (i = 0; i < NE; i++) {
      struct entry *c = &s->e[i];
      if (c->pins) continue;
      if (!e || c->seq < e->seq) e = c;
    }
  }
  if (e) {
    old = e->used ? e->gm : 0;
    e->seq = ++s->seq;
    e->fp = fp;
    e->dims = dims;
    e->gm = gm;
    e->gm_len = n;
    e->pins = 0;
    e->done = 0;
    e->used = 1;
  }
  unlock(s);
  for (i = 0; i < nv; i++) k->free(victims[i]);
  if (!e) { k->free(gm); s->d[D_POST_REASON] = 10; return; }
  if (old) k->free(old);
  s->d[D_POST_GMLEN] = n;
  s->d[D_POST_OK]++;
  s->d[D_POST_REASON] = 0;
}

/* ---------------------------------------------------------------- the writer */

static u32 decimal(u8 *out, u32 v) {
  u8 t[10];
  u32 n = 0, i;
  do { u32 q = 0, r = v; while (r >= 10) { r -= 10; q++; } t[n++] = (u8)('0' + r); v = q; } while (v);
  for (i = 0; i < n; i++) out[i] = t[n - 1 - i];
  return n;
}

/* The segments inserted after the camera's header: XMP, ISO version, MPF; or none (e == 0). Then
 * the diagnostics segment in diagnostic builds. Returns their length, 0 if they do not fit. */
static u32 segments(const struct ctx *k, struct state *s, struct wslot *w, const struct entry *e, u32 H, u32 M) {
  u8 *o = w->seg;
  u32 n = 0, i;
  if (e) {
    u32 x0 = n, len, tiff, primary;
    if (k->xmp_pre_len + k->xmp_post_len + 16 + k->iso_len + 90 > SEG_MAX) return 0;
    o[n++] = 0xff; o[n++] = 0xe1; n += 2;
    copy(o + n, k->xmp_pre, k->xmp_pre_len); n += k->xmp_pre_len;
    n += decimal(o + n, e->gm_len);
    copy(o + n, k->xmp_post, k->xmp_post_len); n += k->xmp_post_len;
    put16(o + x0 + 2, n - x0 - 2);
    copy(o + n, k->iso, k->iso_len); n += k->iso_len;
    /* MPF: FF E2, length 88, "MPF\0", big-endian TIFF header, index IFD (3 entries), 2 MP entries */
    len = 88;
    tiff = H + n + 8;
    primary = 0; /* filled below */
    o[n] = 0xff; o[n + 1] = 0xe2; put16(o + n + 2, len);
    o[n + 4] = 'M'; o[n + 5] = 'P'; o[n + 6] = 'F'; o[n + 7] = 0;
    {
      u8 *t = o + n + 8;
      u32 seglen;
      t[0] = 'M'; t[1] = 'M'; t[2] = 0; t[3] = 0x2a; put32(t + 4, 8);
      put16(t + 8, 3);
      put16(t + 10, 0xb000); put16(t + 12, 7); put32(t + 14, 4); t[18] = '0'; t[19] = '1'; t[20] = '0'; t[21] = '0';
      put16(t + 22, 0xb001); put16(t + 24, 4); put32(t + 26, 1); put32(t + 30, 2);
      put16(t + 34, 0xb002); put16(t + 36, 7); put32(t + 38, 32); put32(t + 42, 50);
      put32(t + 46, 0);
      seglen = n + 90;
      if (k->flags & FLAG_DIAG) seglen += 4 + 10 + 4 * D_END;
      primary = H + seglen + M;
      put32(t + 50, 0x00030000u); put32(t + 54, primary); put32(t + 58, 0); put16(t + 62, 0); put16(t + 64, 0);
      put32(t + 66, 0); put32(t + 70, e->gm_len); put32(t + 74, primary - tiff); put16(t + 78, 0); put16(t + 80, 0);
    }
    n += 90;
  }
  if (k->flags & FLAG_DIAG) {
    if (n + 4 + 10 + 4 * D_END > SEG_MAX) return 0;
    o[n] = 0xff; o[n + 1] = 0xef; put16(o + n + 2, 2 + 10 + 4 * D_END);
    o[n + 4] = 'G'; o[n + 5] = 'R'; o[n + 6] = 'M'; o[n + 7] = 'O'; o[n + 8] = 'D';
    o[n + 9] = 'H'; o[n + 10] = 'D'; o[n + 11] = 'R'; o[n + 12] = 0; o[n + 13] = DIAG_VERSION;
    for (i = 0; i < D_END; i++) put32le(o + n + 14 + 4 * i, s->d[i]);
    n += 4 + 10 + 4 * D_END;
  }
  return n;
}

static u32 header_ok(const u8 *hdr, u32 H) {
  u32 i = 2;
  if (hdr[0] != 0xff || hdr[1] != 0xd8) return 0;
  while (i < H) {
    u32 m, len;
    if (i + 4 > H || hdr[i] != 0xff) return 0;
    m = hdr[i + 1];
    if (m < 0xe0 || m > 0xef) return 0;
    len = be16(hdr + i + 2);
    if (len < 2) return 0;
    i += 2 + len;
  }
  return i == H;
}

/* Diagnostic builds, a file written as the camera's two blocks: a third block after the camera's
 * EOI with the counters. The camera's two blocks are copied as they are (GetWriteBlockInfo gives
 * this + 0x54 + 12 i). Without the lock (counters only; a writer slot is taken over at worst).
 * Returns the block count. */
static u32 tail(const struct ctx *k, struct state *s, const u8 *self, const u32 *b) {
  struct wslot *w = 0;
  u32 i, end, n;
  u8 *o;
  if (!(k->flags & FLAG_DIAG)) return 2;
  if (b[0] != 0 || b[3] != b[2] || b[2] > 0x01000000u || b[5] > 0x40000000u) return 2;
  end = b[3] + b[5];
  if (end < b[3]) return 2;
  for (i = 0; i < NW; i++) if (s->w[i].self == self) { w = &s->w[i]; break; }
  if (!w) {
    for (i = 0; i < NW; i++) if (!w || s->w[i].use < w->use) w = &s->w[i];
    if (w->e) { if (w->e->pins) w->e->pins--; w->e->done = 1; w->e = 0; }
    w->self = self;
  }
  w->use = ++s->use;
  s->d[D_TAILS]++;
  if (k->counters) { s->d[D_EXEC] = k->counters[0]; s->d[D_CNT] = k->counters[1]; }
  s->d[D_SEQ] = s->seq;
  o = w->tail;
  o[0] = 'G'; o[1] = 'R'; o[2] = 'M'; o[3] = 'O'; o[4] = 'D'; o[5] = 'H'; o[6] = 'D'; o[7] = 'T';
  put32le(o + 8, DIAG_VERSION);
  put32le(o + 12, D_END);
  for (i = 0; i < D_END; i++) put32le(o + 16 + 4 * i, s->d[i]);
  n = 16 + 4 * D_END;
  for (i = 0; i < 6; i++) w->blocks[i] = b[i];
  w->blocks[6] = end; w->blocks[7] = (u32)o; w->blocks[8] = n;
  w->seg_len = 0;
  w->n = 3;
  return 3;
}

static u32 count(const struct ctx *k, const u8 *self) {
  struct state *s = get_state(k, (k->flags & FLAG_DIAG) ? 2 : 0);
  const u32 *b;
  const u8 *hdr, *A;
  u32 H, M, dims = 0, fp, i, reason = 0;
  struct wslot *w = 0;
  struct entry *e = 0;
  if (!s || !ram(self) || ((u32)self & 3u)) return 2;
  s->d[D_W_CALLS]++;
  b = (const u32 *)(self + 0x54);
  if (k->flags & FLAG_DIAG) {
    if (k->counters) { s->d[D_EXEC] = k->counters[0]; s->d[D_CNT] = k->counters[1]; }
    s->d[D_W_SELF] = (u32)self;
    s->d[D_W_VT] = *(const u32 *)self;
    for (i = 0; i < 21; i++) s->d[D_W_RAW + i] = ((const u32 *)(self + 0x40))[i];
  }
  hdr = (const u8 *)b[1]; H = b[2]; A = (const u8 *)b[4]; M = b[5];
  if (b[0] != 0 || b[3] != H || !ram(hdr) || !ram(A) || !ram(A + M) || H < 64 || H > 0x20000u) reason = 1;
  else if (!header_ok(hdr, H)) reason = 2;
  else if (M < STREAM_MIN || M > STREAM_MAX) reason = 3;
  else {
    flush(k, A, 1024);
    if (!(dims = stream_dims(A, 1024))) reason = 3;
  }
  if (reason) {
    /* This writer's blocks are the camera's: forget what it was given before. */
    s->d[D_W_REASON] = reason;
    if (lock(s)) {
      for (i = 0; i < NW; i++) {
        w = &s->w[i];
        if (w->self != self) continue;
        if (w->e) { if (w->e->pins) w->e->pins--; w->e->done = 1; }
        w->e = 0;
        w->n = 2;
      }
      unlock(s);
    } else {
      for (i = 0; i < NW; i++) if (s->w[i].self == self) s->w[i].n = 2;
    }
    return tail(k, s, self, b);
  }
  fp = fingerprint(A, dims);
  flush(k, A + FP_OFF, FP_LEN);
  s->d[D_W_FP] = fp; s->d[D_W_DIMS] = dims; s->d[D_W_M] = M;
  if (!lock(s)) {
    s->d[D_W_REASON] = 6;
    for (i = 0; i < NW; i++) if (s->w[i].self == self) s->w[i].n = 2;
    return tail(k, s, self, b);
  }
  for (i = 0; i < NW; i++) if (s->w[i].self == self) { w = &s->w[i]; break; }
  if (!w) {
    for (i = 0; i < NW; i++) if (!w || s->w[i].use < w->use) w = &s->w[i];
    w->self = self;
  }
  w->use = ++s->use;
  for (i = 0; i < NE; i++) {
    struct entry *c = &s->e[i];
    if (c->used && c->fp == fp && c->dims == dims && (!e || c->seq > e->seq)) e = c;
  }
  if (w->e != e) {
    if (w->e) { if (w->e->pins) w->e->pins--; w->e->done = 1; }
    if (e) e->pins++;
    w->e = e;
  }
  {
    u32 n = (e || (k->flags & FLAG_DIAG)) ? segments(k, s, w, e, H, M) : 0;
    w->seg_len = n;
    if (!n) {
      if (w->e && w->e->pins) w->e->pins--;
      w->e = 0;  /* (not done: it was not written) */
      w->n = 2;
      if (k->flags & FLAG_DIAG) { unlock(s); return tail(k, s, self, b); }
    } else {
      w->blocks[0] = 0; w->blocks[1] = (u32)hdr; w->blocks[2] = H;
      w->blocks[3] = H; w->blocks[4] = (u32)w->seg; w->blocks[5] = n;
      w->blocks[6] = H + n; w->blocks[7] = (u32)A; w->blocks[8] = M;
      w->n = 3;
      if (e) {
        w->blocks[9] = H + n + M; w->blocks[10] = (u32)e->gm; w->blocks[11] = e->gm_len;
        w->n = 4;
      }
    }
  }
  s->d[D_SEQ] = s->seq;
  {
    u32 kept = 0;
    for (i = 0; i < NE; i++) if (s->e[i].used) kept++;
    s->d[D_KEPT] = kept;
  }
  if (e) s->d[D_W_MATCH]++;
  s->d[D_W_REASON] = e ? 0 : 5;
  i = w->n;
  unlock(s);
  return i;
}

static u32 info(const struct ctx *k, const u8 *self, u32 i) {
  struct state *s = get_state(k, 0);
  u32 j;
  if (!s) return 0;
  for (j = 0; j < NW; j++) {
    struct wslot *w = &s->w[j];
    if (w->self == self) return w->n > 2 && i < w->n ? (u32)&w->blocks[3 * i] : 0;
  }
  return 0;
}

