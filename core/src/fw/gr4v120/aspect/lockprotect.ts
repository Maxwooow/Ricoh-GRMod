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
 * The change: the tail call `b 0x5325784C` of the lock button's branch goes to a stub. With the
 * single picture in front it makes that same request and returns (the trigger is not passed on);
 * in every other case it passes trigger 4 on as before.
 */
import { assembleWords, branchWord } from './arm';
import { Patch, expectWord } from './build';
import { adr } from '../target';

/** `b MODE_TRIGGER` after `mov r1, #4`: the lock button, pushed. Stack and registers as at the function's return. */
const LOCK_PUSHED = adr(0x53257e38);
/** The mode state machine's trigger: (this, trigger). */
const MODE_TRIGGER = adr(0x5325784c);
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
}
