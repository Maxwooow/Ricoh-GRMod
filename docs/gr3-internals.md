# GR III 2.10 internals: looks, settings, lists, menus, keys and texts

What the work on white balance per look, Custom 1 / 2 first and the look order on the camera found out about the
GR III 2.10 firmware, gathered in one place for whoever builds on it. The implementation is described in
[technical-notes.md](technical-notes.md) (GR III and GR IIIx).

Addresses are those of the GR III 2.10 / GR IIIx 1.60 program (RTOS base 0x53000000, RAM 0x55000000); the code
reaches them through `adr()`, and `tools/port` maps them for 2.20 / 2.21 (1.70 / 1.71). Everything here was seen running in
the emulator probes of `tools/gr3x` (the camera's code executed in the built image), and the features built on it
were checked on a GR III 2.10.

## Looks

| Id | Look | Id | Look |
| --- | --- | --- | --- |
| 11 | Standard | 17 | Positive Film |
| 12 | Vivid | 18 | Bleach Bypass |
| 13 | Monotone | 19 | Retro |
| 14 | Soft Monotone | 20 | HDR Tone |
| 15 | Hard Monotone | 21 | Cross Processing |
| 16 | Hi-Contrast B&W | 22 | Negative Film |

GR Mod's films (round 10) are looks 64 and up; they borrow Bleach Bypass's parameter fields (`tools/gr3x/native/films.c`).

- The still list (Image Control, ADJ) has every look. The movie list has ten: not Soft Monotone (14) nor HDR Tone (20).
- RAW development has twelve, in the order 11..16, 22, 17..21, and its dial counts twelve by itself (0x53283c08,
  `mov r0,#12`).

## Settings records (UserData)

- **UserDataModel** is at 0x55063f30. The record in use is at +4, and the seven stored ones (the shooting modes and
  U1..U3) at +8.. Their layout is the same.
- **Looks and sets.** The look of photo set c (0 standard, 1 Custom 1, 2 Custom 2) is at 0x1c2 + 2c, the look of movie
  set c at 0x57e + 2c. The photo set in use (StillActiveImageControlSet) is at 0x1c0.
- **Still white balance.** It is at 0x178..0x1af:
  - StillWhiteBalance at 0x178;
  - the G-M shift of the 13 modes at 0x17a.., then their B-A shift at 0x194..;
  - StillWhiteBalanceColorTemp at 0x1ae, a half-word.

  Each value byte is followed by a flag byte, which the record copy routine (0x53247288) uses.
- **Setters** (UserDataModel*, value): each stores the value, then tells the listeners.
  - white balance: mode 0x532721e4, G-M 0x53272378 + 0x20·k, B-A 0x5327292c + 0x20·k, colour temperature 0x53272ee0;
  - photo set in use 0x5327b374;
  - look of photo set c 0x5327b394 + 0x20·c, look of movie set c from 0x5327b54c.

  The look setters write the look, then push the whole record to the live values (0x532750f8). The movie setters
  write all eight records.
- **How they were found:** through the settings text interface (names at 0x53b23d1c.., parsers at 0x532df1bc..,
  which call the setters).

## ImageControlModel

| What | Where |
| --- | --- |
| The app's singleton | 0x5320ad88 |
| ImageControlModel (of the singleton) | 0x5320ba9c |
| The resource context for texts and icons (of the singleton) | 0x5320b67c |
| Number of looks in the current list / look of entry i / entry of a look | 0x532c2a9c / 0x532c2c80 / 0x532c2f08 |
| Photo set in use / look in use | 0x532bd6d4 / 0x532bd6b4 |
| Choose a set / choose a look | 0x532bd61c / 0x532c26c0 |
| Which list the model serves: byte +0x1b (0 still and ADJ, 1 movie, 2 RAW development) | written by 0x532bd60c, read by 0x532bd614 |
| A look's name / icon (context, look) | 0x532922b4 / 0x532935dc |
| A text / icon by id (context, id): 0x17 Custom 1, 0x18 Custom 2 | 0x532a985c / 0x532a9988 |

Custom 1 / 2 are **not** in the model. Every screen adds them itself, as entries n and n + 1 after the model's n
looks.

## The screens that list the looks

**1. Row table** (0x53b39d54 for Image Control). It holds five functions per setting, 8 bytes apart:

| Function | Address |
| --- | --- |
| text | 0x531a0538 |
| icon | 0x531a0690 |
| is it the current one | 0x531a1500 |
| select | 0x531a0ba0 |
| count (n + 2) | 0x531a0514 |

The other settings' groups follow in the table (for example 0x53b39ddc). The shooting menu's Image Control row
uses this table, and so does the **ADJ lever's list** when Image Control is one of the ADJ mode settings. Each
function takes the entry in r1.

The icon function does more than return an icon: it sets the icon on item r1 of the list at `this + 0x1f0`
(the item getter call at 0x531a06f0). A change that maps r1 at the function's entry must map that item back too.
Otherwise the names follow the new order while the icons stay in the camera's order.

**2. Image Control screen strip** (the list at `this + 0x174`). Its steps on opening:
1. Opening goes through 0x531ac140.
2. 0x531ab4d0 sets the model's +0x1b from the shooting mode (0x5316dd10).
3. 0x531abb24 sets the strip up: SetVisibleLineItemCount n + 2, and a functor (0x531ab9c4) for the selection, which
   calls select (0x531ab998) and the name line (0x531ab750).
4. 0x531ab7e4 fills it: the looks, then Custom 1 / 2. The item getter is called at 0x531ab854 / 884 / 8ac.
5. 0x531aba5c places it, then 0x531abf20 runs.
6. 0x531abe9c draws the current-entry dots, through 0x531abe0c, which takes the entry in r2.

The name line and the selection read the entry under the cursor through 0x53394820 (at 0x531ab764 / 0x531ab9ac).

**3. RAW development**: count 0x53283358, base 0x532834d0, look 0x532834f0.

**4. The detail screen's look selector** (0x531aeab4) lists the looks only, without Custom 1 / 2.

> Disproved while debugging (no need to try it again): the camera does **not** show a strip's icons in the order
> they are set. The item getter indexes an array, and an item's place is its index × the row height.

## ScrollListView (the lists' widget)

| What | Where |
| --- | --- |
| vtable; SetRect is its entry +0x18 (rect: int32 x, y, w, h) | 0x53c0a300; 0x53395918 |
| Item i (array of pointers at +0xf4, the item is the first word) | 0x53394758 |
| Entry under the cursor (half-word at +0x110) | 0x53394820 |
| Move the cursor by delta (scrolls as little as needed) | 0x53395260(list, delta, 1) |
| "Focus" on entry i: goes to the last row then back, **so the list scrolls** | 0x53395430 |
| SetVisibleLineItemCount; row height at +0x120 | 0x53394e8c |
| Set a functor (callback) | 0x53394b38 |
| Item: icon / current dot / check mark / text | 0x533a1734 / 0x533a19b4 / 0x5339e738 / 0x5339e7a0 |
| A widget's visibility; a title's text | 0x533ad3c0; 0x533a2ba0 |

## Adding a line and a screen to the menu

- **A still menu line**, as the date imprint does (`datestamp.ts`): two copies of the menu's descriptors, without
  ND (item 13, id 0x02000069) and HDF (item 25, id 0x0200013f). Builder 0x5319a778, factory 0x5316f3b8, at most 38
  items. The look order screen takes the same line, so it cannot be combined with the date imprint or End Screen
  pictures.
- **Controller ids.** GR III's own end at 0x02000140, and GR Mod's start at 0x020001a0. End Screen is 0x020000ad,
  D-Range 0x020000ba.
- **The End Screen list** (GoodByeDisplaySetController) is reused in a mode of its own:
  - vtable 0x53b4d248, OnEvent 0x53204928;
  - handlers: refresh 0x532049fc, confirm 0x532048c4, up 0x53204834, down 0x53204878, footer 0x53204ab0;
  - rows built at 0x532044c4;
  - layout at 0x53b4d290: the list's rect is 0, 300, 720, 120, which shows only two rows; the title is at +0x15c,
    the footer picture at +0x164, the list at +0x168.
- **Its events**: 0xd0 up, 0xd1 down, 0xd4 / 0xd5 their repeats, 0xd8 confirm, 0xa2 back to the parent, 0xda then
  0x35 for MENU. Left and right never reach this list.

## Keys

ActionModel::OnEvent (0x53221a1c) turns a key into the current screen's events:
- the key number is in r5 (`mov r5,r1` at 0x53221a38);
- the current controller's id is read at 0x53221a4c;
- a table of handlers per id then posts the events.

| Controller id | Handler | OK | Left | MENU |
| --- | --- | --- | --- | --- |
| 0x020000ad (End Screen) | 0x532157f8 | 0xd8 then 0xa2 (confirm, then leave) | same as OK | 0xda + 0x35 |
| 0x04000023 | 0x53214138 (called at 0x53222a74) | 0xd8 alone | | 0x35 alone |
| 0x020000ba (D-Range) | 0x53215d50 | 0xd8 | 0xa2 alone | 0x35 alone |

On the End Screen list, 0xa2 alone and 0x35 alone do nothing: going back needs 0xd8 then 0xa2. Key numbers: OK is 14
and 50, left is 11. DISP's number is not known yet.

## Texts and fonts

- **Table.** The table at 0x55002bac has one row per camera language, in the order of `GR3X_TEXT_ROWS`: ja, en, fr,
  de, es, pt, it, nl, da, sv, fi, pl, cs, hu, tr, el, ru, ko, zh-TW, zh-CN, th. **Row 0 is Japanese.**
- **Rows and descriptors.** A row has 786 text descriptors (793 on 2.21). A descriptor is a byte n (the length + 1),
  then at +4 a pointer to the UTF-16 text.
- **Useful ids:** 1 On, 2 Off, 214 Bracketing Order, 266 Image Control, 408 Playback Order Options.
- **Fonts.** A language's font has the characters its own texts use, and not necessarily any others
  (`gr3xAllowedChars`). For example, 非 (ja), ù (it), 숨김 (ko) and 隱藏 / 隐藏 (zh) are absent. An added text is safe
  when it is made of the camera's own words in that language and is at most 24 characters long.

## Settings store (HTData)

- **Functions:** store singleton 0x53828014, write 0x53829a08, read 0x53829fcc, size 0x53829e50. The allocator is
  0x536af2a8.
- **Records.** Records 0..15 are accepted, and each is a file `HTData%02d`. The camera uses 0 and 2..8. GR Mod uses:
  - 12: the films' parameters;
  - 13: the End Screen pictures;
  - 14: white balance per look ('GRW3');
  - 15: the look order ('GR3L').
- **RAM gap.** Round 10 clears 0x55804374..0x558043c0 at every start. In it, 0x5580438c holds the look order's
  query (0 until the settings are loaded), and 0x55804390 holds the order screen's mode.

## Tools

- `tools/gr3x/disasm.py`: reads A32 at given addresses.
- The `*_probe.py` files run the patched camera functions in unicorn against the built image, with the camera's
  stores, widgets and getters substituted. They start from the decompressed official RTOS and a build's manifest.
