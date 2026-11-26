// SPDX-License-Identifier: GPL-2.0-only
/**
 * The mode dial's lock button protects the picture in single-picture playback (test builds only,
 * `TestOptions.lockProtect`; GR IV 1.20 and 1.21). A press sets Protect for the displayed file, a
 * press on a protected file releases it: what "Protect > Single file" of the playback menu does.
 *
 * What the camera does (1.20 addresses). The button is switch 0x26 ("Lock"). The switch model
 * hands every switch to 0x53257A14, which turns it into a trigger of the mode state machine
 * (0x5325784C): for the lock button, pushed (event data: byte 2, then a zero word), trigger 4. No
 * state of that machine does anything with trigger 4 itself; it only runs the callbacks registered
 * for it (the return from the shifted program in P). Nothing in playback uses the button.
 *
 * The screen in front is a controller with an id; the current id is the first word of the
 * controller queue (0x53240818). Playback is 0x04000000, which the controller table (0x531871BC)
 * resolves with PlaybackModel's GetControllerId (0x53261F1C): 0x04000001 the single picture
 * (PlaybackSingleController), 0x04000004 the thumbnails, others for the folder and calendar views.
 * Menus and dialogs opened from playback have ids of their own (0x02......).
 *
 * The playback menu's Protect for one file (0x531F10C4) is
 *     model = MediaModel; if (allowed(model, 4) && RequestProtectSingle(model)) <wait in the menu>
 * RequestProtectSingle (0x5326676C) takes the displayed file from PlaybackModel, refuses while
 * another request is running (model +8 not 0) and sends the request; MediaModel itself goes back
 * to idle when the answer arrives (0x5326947C), whoever asked.
 *
 * The button's events (switch model, 0x53272F20; a type 1 switch) carry the byte 2 with a zero word
 * or the byte 1 with a count. Only the first reaches the translator's lock branch as something to
 * do (trigger 4); a build that waited for the second (camera test 120) never made the request.
 *
 * The change: the tail call `b 0x5325784C` of the lock button's branch goes to a stub. With the
 * single picture in front it makes the menu's request and returns (the trigger is not passed on);
 * in every other case it passes trigger 4 on as before.
 *
 * When the request has succeeded MediaModel empties PlaybackModel's record of the displayed file
 * (0x5326923C) and posts event 0x132 (0x53269090; 0x133 with a reason, 0x134 for the answer's
 * status 3). The camera's own way to this request, the panel opened from
 * the single picture (controller ids 0x0400002C.., event handler 0x531F3318), answers 0x132 by
 * asking for the picture to be displayed again (0x531F25E0: 0x531F24BC(this, 2)), which is why its
 * Protect mark changes at once. The single picture's own controller (event handler 0x53196528)
 * ignores 0x132: after the button's request nothing asked for the picture again (camera tests
 * 119, 121, 122: no Protect mark, the direction keys dead until the screen was drawn again; 121
 * and 122 answered 0x134, which did not come). On 0x132 the handler now makes the
 * controller's own request of its start (0x53195B64: 0x53193950(this, 2, 0)), when the single
 * picture is the controller's screen (0x53185054).
 */
import { assembleWords, branchWord } from './arm';
import { Patch, expectWord } from './build';
import { adr } from '../target';

/** `b MODE_TRIGGER` after `mov r1, #4`: the lock button's event. Stack and registers as at the function's return. */
const LOCK_PUSHED = adr(0x53257e38);
/** The mode state machine's trigger: (this, trigger). */
const MODE_TRIGGER = adr(0x5325784c);
/** PlaybackSingleController's event handler: `movw r2, #0x135` of its compare, and the case of that event. */
const SINGLE_EVENT_135 = adr(0x5319661c);
/** The handler's exit for an event it does nothing with (`mov r0, #0`, return). */
const SINGLE_EVENT_DONE = adr(0x531966c0);
/** The controller's screen id (this), and its request to display the picture: (this, 2, 0) at its start. */
const CONTROLLER_SCREEN = adr(0x53185054);
const SINGLE_DISPLAY = adr(0x53193950);
/** The application object, and from it the controller queue, PlaybackModel and MediaModel. */
const APP = adr(0x532406a4);
const CONTROLLER_QUEUE = adr(0x53240818);
const PLAYBACK_MODEL = adr(0x53240998);
const MEDIA_MODEL = adr(0x532409f8);
/** PlaybackModel::GetControllerId. */
const PLAYBACK_CONTROLLER_ID = adr(0x53261f1c);
/** MediaModel: may this request be made now (r1 = 4, as the menu asks). */
const REQUEST_ALLOWED = adr(0x532684fc);
/** MediaModel::RequestProtectSingle. */
const REQUEST_PROTECT_SINGLE = adr(0x5326676c);

const PLAYBACK = 0x04000000;

const condition = (word: number, cond: number): number => ((word & 0x0fffffff) | (cond << 28)) >>> 0;

export function installLockProtect(patch: Patch): void {
  expectWord(patch, LOCK_PUSHED - 12, 0xe3a01004); // mov r1, #4
  expectWord(patch, LOCK_PUSHED - 8, 0xe24bd014); // sub sp, fp, #0x14
  expectWord(patch, LOCK_PUSHED - 4, 0xe89d6830); // ldm sp, {r4, r5, fp, sp, lr}
  expectWord(patch, LOCK_PUSHED, branchWord(LOCK_PUSHED, MODE_TRIGGER));
  expectWord(patch, CONTROLLER_QUEUE, 0xe1a0c00d); // mov ip, sp
  expectWord(patch, PLAYBACK_CONTROLLER_ID, 0xe1a0c00d);
  expectWord(patch, REQUEST_PROTECT_SINGLE, 0xe1a0c00d);
  expectWord(patch, REQUEST_PROTECT_SINGLE + 0x18, 0xe5d05008); // ldrb r5, [r0, #8]: busy
  expectWord(patch, REQUEST_ALLOWED + 0x10, 0xe16f0f10); // clz r0, r0
  expectWord(patch, SINGLE_EVENT_135, 0xe3002135); // movw r2, #0x135
  expectWord(patch, SINGLE_EVENT_135 + 4, 0xe1530002); // cmp r3, r2
  expectWord(patch, SINGLE_EVENT_DONE, 0xe3a00000); // mov r0, #0
  expectWord(patch, SINGLE_EVENT_DONE + 4, 0xe89da800); // ldm sp, {fp, sp, pc}
  expectWord(patch, CONTROLLER_SCREEN, 0xe5900124); // ldr r0, [r0, #0x124]
  expectWord(patch, SINGLE_DISPLAY, 0xe1a0c00d);

  const stub = patch.append((at) => assembleWords(
    `push {r0, r4, r5, lr}
     bl #${APP}
     bl #${CONTROLLER_QUEUE}
     ldr r4, [r0]
     cmp r4, #${PLAYBACK}
     bne known
     bl #${APP}
     bl #${PLAYBACK_MODEL}
     bl #${PLAYBACK_CONTROLLER_ID}
     mov r4, r0
     known:
     sub r4, r4, #${PLAYBACK}
     cmp r4, #1
     bne pass
     bl #${APP}
     bl #${MEDIA_MODEL}
     mov r4, r0
     mov r1, #4
     bl #${REQUEST_ALLOWED}
     cmp r0, #0
     beq done
     mov r0, r4
     bl #${REQUEST_PROTECT_SINGLE}
     done:
     mov r0, #0
     add sp, sp, #4
     pop {r4, r5, pc}
     pass:
     pop {r0, r4, r5, lr}
     mov r1, #4
     b #${MODE_TRIGGER}`, at), 4);
  patch.setWord(LOCK_PUSHED, branchWord(LOCK_PUSHED, stub), 'lock button: Protect in single-picture playback');

  const event = patch.append((at) => assembleWords(
    `movw r2, #0x132
     cmp r3, r2
     movw r2, #0x135
     bne #${SINGLE_EVENT_135 + 4}
     push {r4, lr}
     mov r4, r0
     bl #${CONTROLLER_SCREEN}
     sub r0, r0, #${PLAYBACK}
     cmp r0, #1
     bne over
     mov r0, r4
     mov r1, #2
     mov r2, #0
     bl #${SINGLE_DISPLAY}
     over:
     pop {r4, lr}
     b #${SINGLE_EVENT_DONE}`, at), 4);
  patch.setWord(SINGLE_EVENT_135, branchWord(SINGLE_EVENT_135, event), 'single picture: display it again when a request is done (event 0x132)');
}
