// SPDX-License-Identifier: GPL-2.0-only
/*
 * More ADJ lever slots (GR IV firmware 1.11): the parts of AdjModeController that this program
 * replaces or extends for slots 6..N (N = 6..8), see core/src/fw/aspect/adjslots.ts.
 *
 * Position independent (-fropi -frwpi), no global data: everything the module needs comes in as
 * arguments from the stubs in adjslots.ts (the slot count n, the addresses of tables). The camera's
 * own functions are called at their fixed addresses.
 *
 * The controller object (operator new 0x3A0 instead of 0x294) gets, after its official members:
 *   +0x294  frame views of slots 1..N (u32[8]; the first five are also the official +0x16C..+0x17C)
 *   +0x2B4  icon views of slots 1..N  (u32[8]; the first five also +0x184..+0x194)
 *   +0x2D8  the per-slot state, 2 layouts x N x 12 bytes (officially 2 x 5 x 12 at +0x200; the
 *           official functions that use it are patched to this place and stride, see adjslots.ts)
 *
 * Slots 6..8 are kept in three bytes of the user settings that the firmware never writes (padding
 * after the byte at 0x488 of the settings structure, CURRENT() + 4 + 0x489..0x48B): bits 0..4 the
 * ADJ function (0..0x14, as the official slots at 0x920..0x924), bits 5..7 of the first byte the
 * remembered slot when it is 6..8 (1..3; 0: the official byte 0x91E holds it).
 */
typedef unsigned int u32;
typedef unsigned char u8;
typedef int s32;

#define CALL0(a) ((u32(*)(void))(a))()
#define CALL1(a, x) ((u32(*)(u32))(a))(x)
#define CALL2(a, x, y) ((u32(*)(u32, u32))(a))(x, y)
#define CALL3(a, x, y, z) ((u32(*)(u32, u32, u32))(a))(x, y, z)
#define CALL4(a, x, y, z, w) ((u32(*)(u32, u32, u32, u32))(a))(x, y, z, w)

#define APP 0x5323ea84u
#define USERDATA 0x5323f018u
#define RESOURCES 0x5323f378u
#define IS_FIXED 0x531bcd00u
#define SLOT_FUNCTION 0x531bd580u
#define FUNCTION_TABLE 0x53d9f714u
#define FUNCTION_RECORD 0x5cu
#define ICON_OF 0x533817f0u
#define FRAME_COLOUR 0x5357013cu
#define VIEW_ICON 0x53576e38u
#define VIEW_SHOW 0x53589ab4u
#define VIEW_TOUCHABLE 0x535888a8u
#define CURRENT_MODE 0x53183e14u
#define MODE_NO_TOUCH 0x02000001u
#define OPERATOR_NEW 0x538e09b0u
#define REGISTER_TAP 0x535885a4u
#define TAP_MANAGER 0x531bb7c0u
#define TAP_INVOKER 0x531bb8ecu
#define BIND_VIEWS 0x531831e8u
#define SET_STILL_POSITION 0x5333a114u

#define SETTINGS (0x55084dd8u + 4)
#define EXT (SETTINGS + 0x489)
#define FUNCTIONS 0x15u

#define VIEWS 0x15c
#define OFFICIAL_VIEWS 39
#define FRAMES 0x294
#define ICONS 0x2b4

#define AT(t, off) (*(volatile u32 *)((t) + (off)))
#define BYTE(a) (*(volatile u8 *)(a))

/* Function of slot k (5 <= k < n) as kept: anything above 0x14 is off. */
static u32 ext_function(u32 k) {
  u32 f = BYTE(EXT + (k - 5)) & 0x1f;
  return f >= FUNCTIONS ? 0 : f;
}

/*
 * Call the pointer to member function at rec + off (ARM C++ ABI: {ptr, adj}; adj bit 0: virtual,
 * ptr the offset in the vtable of this + adj / 2). Returns 0 when there is none (ptr 0, not virtual).
 */
static u32 call_member(u32 t, u32 rec, u32 off, u32 *result) {
  u32 ptr = AT(rec, off), adj = AT(rec, off + 4);
  u32 obj = t + (u32)((s32)adj >> 1);
  u32 fn;
  if (adj & 1) {
    fn = AT(AT(obj, 0), ptr);
  } else {
    if (!ptr) return 0;
    fn = ptr;
  }
  *result = CALL1(fn, obj);
  return 1;
}

static u32 record(u32 f) { return FUNCTION_TABLE + f * FUNCTION_RECORD; }

/*
 * SlotFunction (0x531BD580) for slot k > 4, from its out-of-range branch (officially an assertion
 * and 0): slots 6..n in the free layout, nothing (0) in the fixed layout or past n.
 */
u32 adj_slot_function(u32 t, u32 k, u32 n) {
  if (k >= n || k < 5) return 0;
  if (CALL1(IS_FIXED, t) == 1) return 0;
  return ext_function(k);
}

/*
 * Virtual function 9 (officially 0x531BD0AC, read only through the vtable): can the ADJ lever be
 * used, 1 when a slot holds a function that is not disabled (or in the fixed layout).
 */
u32 adj_can_open(u32 t, u32 n) {
  if (CALL1(IS_FIXED, t) == 1) return 1;
  for (u32 k = 0; k < n; k++) {
    u32 f = CALL2(SLOT_FUNCTION, t, k);
    u32 r = 0;
    if (call_member(t, record(f), 0x3c, &r)) {
      if (f == 0) r |= 1;
      if ((r & 0xff) == 0) return 1;
    } else if (f != 0) {
      return 1;
    }
  }
  return 0;
}

/* After the strip is drawn (0x531BFA3C, slots 1..5): slots 6..n, as the official loop draws one. */
void adj_draw_more(u32 t, u32 n) {
  u32 res = CALL1(RESOURCES, CALL0(APP));
  for (u32 k = 5; k < n; k++) {
    u32 frame = AT(t, FRAMES + 4 * k), icon = AT(t, ICONS + 4 * k);
    u32 f = CALL2(SLOT_FUNCTION, t, k);
    u32 r = 0;
    u32 has = call_member(t, record(f), 0x3c, &r);
    u32 picture = 0, shown = 0;
    if (!(has && r != 0) && f != 0) {
      picture = CALL3(ICON_OF, res + 4, f, 0);
      CALL2(FRAME_COLOUR, frame, 0x10);
      shown = 1;
    }
    CALL2(VIEW_ICON, icon, picture);
    CALL2(VIEW_SHOW, frame, shown);
  }
}

/* After 0x531BD6BC (which slot icons can be touched): slots 6..n. */
void adj_touchable_more(u32 t, u32 n) {
  u32 none = CALL1(CURRENT_MODE, t) == MODE_NO_TOUCH;
  for (u32 k = 5; k < n; k++) {
    u32 on = none ? 0 : (CALL2(SLOT_FUNCTION, t, k) != 0);
    CALL2(VIEW_TOUCHABLE, AT(t, ICONS + 4 * k), on);
  }
}

/*
 * After 0x531BBB40 (a tap on slot k's icon selects it): slots 6..n, with taps[k - 5] the handler
 * (as 0x531BF9D8..0x531BFA28). The functor and the holder are built as the official code does.
 */
void adj_taps_more(u32 t, u32 n, u32 taps) {
  for (u32 k = 5; k < n; k++) {
    u32 functor = CALL1(OPERATOR_NEW, 12);
    AT(functor, 0) = AT(taps, 4 * (k - 5));
    AT(functor, 4) = 0;
    AT(functor, 8) = t;
    volatile u32 holder[4];
    holder[0] = functor;
    holder[1] = 0;
    holder[2] = TAP_MANAGER;
    holder[3] = TAP_INVOKER;
    CALL2(REGISTER_TAP, AT(t, ICONS + 4 * k), (u32)holder);
    u32 manager = holder[2];
    if (manager) CALL3(manager, (u32)holder, (u32)holder, 3);
  }
}

/*
 * Instead of the constructor's BindViews(this, this + 0x15C, table, 39): the views of the table of
 * 39 + 2 (n - 5) entries (adjslots.ts: the official ones, frames and icons of n slots, in the
 * official order of kinds: frames, selection, icons) into a local array, then each to its member.
 */
void adj_bind(u32 t, u32 table, u32 n) {
  u32 views[OFFICIAL_VIEWS + 6];
  u32 more = 2 * (n - 5);
  CALL4(BIND_VIEWS, t, (u32)views, table, OFFICIAL_VIEWS + more);
  for (u32 i = 0; i < OFFICIAL_VIEWS; i++) {
    u32 j;
    if (i < 9) j = i;                         /* root, texts, frames of slots 1..5 */
    else if (i == 9) j = 4 + n;               /* selection */
    else if (i < 15) j = 5 + n + (i - 10);    /* icons of slots 1..5 */
    else j = i + more;
    AT(t, VIEWS + 4 * i) = views[j];
  }
  for (u32 k = 0; k < 8; k++) {
    AT(t, FRAMES + 4 * k) = k < n ? views[4 + k] : 0;
    AT(t, ICONS + 4 * k) = k < n ? views[5 + n + k] : 0;
  }
}

/* The remembered slot of the free layout (instead of the getter of 0x91E in 0x531BED64). */
u32 adj_get_position(u32 settings, u32 n) {
  u32 e = BYTE(EXT) >> 5;
  if (e && e + 4 < n) return e + 4;
  u32 p = BYTE(settings + 0x91e);
  return p < 5 ? p : 0;
}

/* Keep the remembered slot (instead of the setter of 0x91E): 0x91E only ever gets 0..4. */
void adj_set_position(u32 settings, u32 p, u32 n) {
  u32 b = BYTE(EXT) & 0x1f;
  if (p >= 5 && p < n) {
    BYTE(EXT) = (u8)(b | ((p - 4) << 5));
    CALL2(SET_STILL_POSITION, settings, 4);
  } else {
    BYTE(EXT) = (u8)b;
    CALL2(SET_STILL_POSITION, settings, p < 5 ? p : 0);
  }
}
