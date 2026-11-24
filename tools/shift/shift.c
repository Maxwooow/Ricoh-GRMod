// SPDX-License-Identifier: GPL-2.0-only
// Sensor Shift (GR IV 1.20 / 1.21): the camera-side module of core/src/fw/gr4v120/aspect/shift.ts.
//
// The picture is moved and turned by hand with the shake reduction unit (as the "Composition
// Adjustment" of Pentax bodies): while the adjustment is on, the four-way controller shifts the
// sensor, the dials turn it, DISP brings it back to the centre; shake reduction is off as long as
// the sensor is away from the centre or the adjustment is on. Nothing is kept when the camera is
// switched off.
//
// Position independent, no data sections: every firmware address comes in `struct ctx`, written by
// shift.ts for the release the firmware is built on. One entry, `shift(ctx, which, a, b, c)`, at
// offset 0; shift.ts's hooks call it with `which`:
//
//   0 key(_, id, ev)     SwitchModel::Notify: 1 = the event is used up here
//   1 fast(msg)          the capture-ready fast path of a switch message: 1 = leave it out
//   2 label(i)           text to show in place of shutter speed (0), aperture (1), ISO (2), or 0
//   3 noicon()           1 = no ISO icon in front of the roll value
//   4 sroff()            1 = report "shake reduction off" to the shake reduction unit
//   5 guide(icon, ascii, text)   the key guide: 1 = filled in ("DISP  Reset")
//   6 adj_enter()   7 adj_leave()   8 adj_draw(self, i)   9 adj_current(i)   10 adj_set(i)
//   11 fn_count(ctrl)   12 fn_draw(ctrl, item, i)   13 fn_set(ctrl, i)   14 fn_current(ctrl, i)
//
// How the sensor is moved (found on a GR IV 1.21; the shake reduction unit's program is the same in
// 1.20): the unit writes its three actuator offsets (auto horizon correction) through three
// pointers into its position registers. The pointers are turned onto the unit's own buffer, so
// that it no longer touches the registers, and the registers are written from here with the
// unit's "write a word" command. Offsets survive shots, the menus, playback and the still / movie
// switch; with all three back at zero the pointers are restored.
typedef unsigned char u8; typedef signed char s8; typedef unsigned short u16; typedef unsigned int u32; typedef int s32;

struct st {            // the state: 0x29 bytes of the unused sbrk arena before the heap, zero at start-up
  u8 mode;             // +0  ON = the adjustment is on (keys taken, values shown)
  s8 vx, vy, r;        // +1..3 shift right / up in steps of 64 units, roll in steps of 0.125 degrees
  u8 disable;          // +4  0x5A = everything passes through (a card script can set it)
  u8 redirected;       // +5  ON = the unit's offset pointers are on its own buffer
  u8 sroff;            // +6  ON = shake reduction reported off
  u8 eat;              // +7  switch whose repeats and release still belong to the press that was used up
  char label[3][5];    // +8  "X+28", "Y-03", "R+18"
  u8 pad17;
  s32 cache[3];        // +0x18 the register values last written
  u8 pad24;
  u8 count;            // +0x25 number of words written to the unit (wraps; for diagnosis)
  u8 free;             // +0x26 ON = no combined limit of shift and roll (a card script can set it)
  u8 pend;             // +0x27 ADJ lever: ON = "Adjust" is the value chosen, else "Off"
  u8 conf;             // +0x28 ADJ lever closed on this function: act on `pend` once the shooting screen is back
};
#define ON 0xA5
#define OFF_SWITCH 0x5A
#define XY_MAX 28      // 28 * 64 = 1792 units, about 1.09 mm (the stops are at about 1.13 mm)
#define R_MAX 18       // 18 * 0.125 = 2.25 degrees (the stop is at about 2.6)

struct ctx {
  u32 magic;                                        // 0
  struct st *st;                                    // 1
  void **srmsg;                                     // 2  -> SrMessage object
  u32 **lv;                                         // 3  -> LiveViewController object
  u32 lv_vtable;                                    // 4
  volatile u32 *screen;                             // 5  current screen id
  const u8 *fn_eff, *hold_eff, *iso_sub, *fn_saved; // 6..9  settings bytes
  const u8 *osd_hide1, *osd_hide2;                  // 10, 11
  const u8 *vis_a, *vis_b;                          // 12, 13 UpdateOsd's two visibility tables (rows of 0x30)
  void (*sr_write)(void *, u32, u32);               // 14 unit command "write a word": (SrMessage, address, value)
  void (*dsp_sr)(void *);                           // 15 report the shake reduction state again: (DspState)
  u32 (*tv)(void *); u32 (*av)(void *); u32 (*sv)(void *); void (*svi)(void *);   // 16..19 the screen's value texts
  void (*item36)(void *, u32, u32); void (*item38)(void *, u32, u32);             // 20, 21 OSD items (LV, number, shown)
  void *(*list_item)(void *, u32);                  // 22 ADJ list view: (list, index) -> item
  void (*item_text)(void *, u32);                   // 23 (item, text number)
  void (*row_draw)(void *, u32, u32);               // 24 Fn list row: (item, icon, text)
  void *(*get_app)(void);                           // 25
  void *(*get_settings)(void *);                    // 26
  u32 (*set_fn)(void *, u32);                       // 27 (settings model, function): the Fn button's function
  void (*fn_draw)(void *, void *, u32);             // 28 the camera's handlers of the Fn button's function list
  u32 (*fn_set)(void *, u32);                       // 29
  u32 (*fn_current)(void *, u32);                   // 30
  u32 function;                                     // 31 the button function's number
  u32 icon, icon_disp;                              // 32, 33
  u32 text_name, text_adjust, text_off, text_guide; // 34..37
  u32 ptr[3], reg[3], buf[3];                       // 38.. the unit's three pointers, registers, buffer words
};

static int in_lv(const struct ctx *c) {
  u32 id = *c->screen;
  return id == 0x08000000 || id == 0x08000002 || id == 0x08000003;
}
static int armed_fn(const struct ctx *c)   { return in_lv(c) && !*c->iso_sub && *c->fn_eff == c->function; }
static int armed_hold(const struct ctx *c) { return in_lv(c) && !*c->iso_sub && *c->hold_eff == c->function; }
static u32 *lv(const struct ctx *c) {
  u32 *o = *c->lv;
  if (!o || ((u32)o & 3) || ((u32)o >> 24) < 0x55 || ((u32)o >> 24) > 0x5f) return 0;
  return *o == c->lv_vtable ? o : 0;
}
static void put2(char *p, s32 v) {
  u32 t = 0;
  p[0] = v < 0 ? '-' : '+'; if (v < 0) v = -v;
  while (v >= 10) { v -= 10; t++; }
  p[1] = (char)('0' + t); p[2] = (char)('0' + v);
}
static void fmt(struct st *s) {
  s->label[0][0] = 'X'; put2(s->label[0] + 1, s->vx); s->label[0][4] = 0;
  s->label[1][0] = 'Y'; put2(s->label[1] + 1, s->vy); s->label[1][4] = 0;
  s->label[2][0] = 'R'; put2(s->label[2] + 1, s->r);  s->label[2][4] = 0;
}
// What the screen's update would pass to OSD item i now: nothing is shown while one of the four "hidden" bytes is set;
// otherwise A[LV+0x2d6][i] ? B[LV+0x2dd][i] : 0 (two rows each).
static u32 item_vis(const struct ctx *c, const u8 *l, u32 i) {
  u32 a = l[0x2d6], b = l[0x2dd];
  if (*c->osd_hide1 || *c->osd_hide2 || l[0x4e5] || l[0x4e6] || a > 1 || b > 1) return 0;
  return c->vis_a[a * 0x30 + i] ? c->vis_b[b * 0x30 + i] : 0;
}
static void guide(const struct ctx *c, u32 *l) {       // the key guide and the item that shares its place
  c->item36(l, 36, item_vis(c, (const u8 *)l, 36)); c->item38(l, 38, item_vis(c, (const u8 *)l, 38));
}
static void show(const struct ctx *c) {
  u32 *l = lv(c);
  if (!l) return;
  c->tv(l); c->av(l); c->sv(l); c->svi(l);
  guide(c, l);
}
static void apply(const struct ctx *c, struct st *s) {
  void *m = *c->srmsg;
  u32 any = (u32)(s->vx | s->vy | s->r), want = (s->mode == ON || any) ? ON : 0, k;
  s32 v[3];
  if (!m) return;
  if (s->sroff != want) { void *d; s->sroff = (u8)want; d = *(void **)((u8 *)m + 0x60); if (d) c->dsp_sr(d); }
  v[0] = -16384 * s->vx - 9998 * s->r;          // r > 0: the picture turns clockwise on the screen
  v[1] = -16384 * s->vy + 13058 * s->r;
  v[2] = -16384 * s->vy - 13013 * s->r;
  if (any && s->redirected != ON) {
    for (k = 0; k < 3; k++) { c->sr_write(m, c->ptr[k], c->buf[k]); s->count++; }
    s->redirected = ON; s->cache[0] = s->cache[1] = s->cache[2] = 0x7fffffff;
  }
  if (s->redirected == ON) {
    for (k = 0; k < 3; k++) if (s->cache[k] != v[k]) { c->sr_write(m, c->reg[k], (u32)v[k]); s->cache[k] = v[k]; s->count++; }
    if (!any) { for (k = 0; k < 3; k++) { c->sr_write(m, c->ptr[k], c->reg[k]); s->count++; } s->redirected = 0; }
  }
}
static int active(const struct st *s) { return s->mode == ON || s->vx || s->vy || s->r; }
// The ADJ lever was closed on this function: once the shooting screen is back, the adjustment starts ("Adjust") or the
// sensor goes back to the centre ("Off").
static int resume(const struct ctx *c, struct st *s) {
  if (s->conf != ON || !in_lv(c)) return 0;
  s->conf = 0;
  if (s->pend == ON) { s->pend = 0; s->mode = ON; fmt(s); apply(c, s); return 1; }
  s->pend = 0;
  if (active(s)) { s->mode = 0; s->vx = s->vy = s->r = 0; fmt(s); apply(c, s); return 1; }
  return 0;
}
// The shift allowed at a roll, measured on the camera: clean up to X20 at R06, X14 at R12, X6 at R18.
static s32 lim(s32 r) { if (r < 0) r = -r; return XY_MAX - (r * 5 + 2) / 4; }
static s32 absi(s32 v) { return v < 0 ? -v : v; }
static void enter_mode(const struct ctx *c, struct st *s) { s->mode = ON; fmt(s); apply(c, s); show(c); }
static void leave_mode(const struct ctx *c, struct st *s) { s->mode = 0; apply(c, s); show(c); }      // the offsets stay

static u32 key(const struct ctx *c, u32 id, const u32 *ev) {
  struct st *s = c->st;
  u32 kind, val, on;
  if (s->disable == OFF_SWITCH) return 0;
  if (resume(c, s)) show(c);
  on = s->mode == ON;
  id &= 0xffff;
  kind = ev[0] & 0xff; val = ev[1];
  if (s->eat && id == s->eat) {                // the rest (repeats, release) of the press that switched the adjustment
    if (kind == 2 && val == 0) s->eat = 0;     // a new press: as any other
    else { if (kind == 1) s->eat = 0; return 1; }
  }
  if (!on) {
    if (id == 27) {                            // Fn set to this function: a press starts the adjustment
      if (!armed_fn(c)) return 0;
      if (kind == 2 && val == 0) { s->eat = 27; enter_mode(c, s); }
      return 1;
    }
    if (id == 28 && kind == 2 && val == 1 && armed_hold(c)) { s->eat = 28; enter_mode(c, s); return 1; }   // Movie button held
    return 0;
  }
  if (!in_lv(c)) { s->mode = 0; apply(c, s); return 0; }     // the shooting screen was left: the adjustment ends, the offsets stay
  if (id == 35) { leave_mode(c, s); return 0; }              // ADJ lever pressed: the adjustment ends and the lever's strip opens
  if (id == 28) {                                            // Movie button: held, it ends the adjustment (when that is its function)
    if (kind == 2 && val == 1 && *c->hold_eff == c->function) { s->eat = 28; leave_mode(c, s); return 1; }
    return 0;
  }
  if (id == 27 || id == 8) {                   // Fn / OK: the adjustment ends, the offsets stay
    if (kind == 2 && val == 0) { s->eat = (u8)id; leave_mode(c, s); }
    return 1;
  }
  if (id == 4) {                               // DISP: back to the centre
    if (kind == 2 && val == 0) { s->vx = s->vy = s->r = 0; fmt(s); apply(c, s); show(c); }
    return 1;
  }
  if ((id >= 9 && id <= 16) || (id >= 31 && id <= 34) || id == 36 || id == 37 || (id >= 40 && id <= 43)) {
    if (kind == 2) {
      s32 x = s->vx, y = s->vy, r = s->r, m;
      if (id == 12) x++; else if (id == 11) x--; else if (id == 9) y++; else if (id == 10) y--;
      else if (id == 31 || id == 33 || id == 36 || id == 40 || id == 42) r++;
      else if (id == 32 || id == 34 || id == 37 || id == 41 || id == 43) r--;
      m = s->free == ON ? XY_MAX : lim(r);
      if (r <= R_MAX && r >= -R_MAX && absi(x) <= m && absi(y) <= m && (x != s->vx || y != s->vy || r != s->r)) {
        s->vx = (s8)x; s->vy = (s8)y; s->r = (s8)r; fmt(s); apply(c, s); show(c);
      }
    }
    return 1;
  }
  return 0;
}
static u32 fast(const struct ctx *c, const u32 *msg) {
  struct st *s = c->st;
  u32 id;
  if (s->disable == OFF_SWITCH) return 0;
  id = msg[0];
  if (id == 0x21600217) return s->mode == ON || armed_fn(c);       // Fn
  if (s->mode != ON) return 0;
  return id == 0x2160020b || id == 0x2160020c;                     // left, right
}
static u32 label(const struct ctx *c, u32 which) {
  struct st *s = c->st;
  if (s->disable == OFF_SWITCH) return 0;
  if (which == 0 && resume(c, s)) {            // the first text of a screen update: the ADJ lever may just have closed
    u32 *l = lv(c);
    if (l) guide(c, l);
  }
  return (s->mode == ON && which < 3) ? (u32)s->label[which] : 0;
}
static u32 fn_rows(void *ctrl) { return (((u32 *)ctrl)[0x1b8 / 4] - ((u32 *)ctrl)[0x1b4 / 4]) & 0xff; }

u32 shift(const struct ctx *c, u32 which, u32 a, u32 b, u32 d) {
  struct st *s = c->st;
  if (which == 0) return key(c, a, (const u32 *)b);
  if (which == 1) return fast(c, (const u32 *)a);
  if (which == 2) return label(c, a);
  if (which == 3) return s->disable != OFF_SWITCH && s->mode == ON;
  if (which == 4) return s->disable != OFF_SWITCH && s->sroff == ON;
  if (which == 5) {
    if (s->disable == OFF_SWITCH || s->mode != ON) return 0;
    *(u16 *)a = (u16)c->icon_disp; *(char *)b = 0; *(u16 *)d = (u16)c->text_guide;
    return 1;
  }
  if (which == 6) { s->pend = active(s) ? ON : 0; s->conf = 0; return 0; }           // the strip opened on, or moved to, this function
  if (which == 7) { if (s->disable != OFF_SWITCH) s->conf = ON; return 0; }          // the strip closed on it
  if (which == 8) {
    u32 t = b == 0 ? c->text_off : (b == 1 ? c->text_adjust : 0);
    c->item_text(c->list_item((void *)((u32 *)a)[0x1f8 / 4], b & 0xff), t);
    return 0;
  }
  if (which == 9) return a == (s->pend == ON ? 1u : 0u);
  if (which == 10) { if (a <= 1) s->pend = a ? ON : 0; return 0; }                   // carried out when the strip closes
  if (which == 11) return (fn_rows((void *)a) + 1) & 0xff;                           // the Fn button's list: one more row
  if (which == 12) {
    if (d < fn_rows((void *)a)) c->fn_draw((void *)a, (void *)b, d); else c->row_draw((void *)b, c->icon, c->text_name);
    return 0;
  }
  if (which == 13) return b < fn_rows((void *)a) ? c->fn_set((void *)a, b) : c->set_fn(c->get_settings(c->get_app()), c->function);
  if (which == 14) return b < fn_rows((void *)a) ? c->fn_current((void *)a, b) : (u32)(*c->fn_saved == c->function);
  return 0;
}
