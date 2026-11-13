import { groupInviteNotice, isGroupInvite, isHiddenFromModel } from "@rine-network/core";
import type { RineInbound } from "./types.js";

/**
 * How the runtime treats a control frame before the model could see it.
 *
 * A sender-key distribution is key material: the readability probe has already
 * ingested it, so the only thing left to do is take it out of `status=new`. No turn
 * is woken for it, because a model that reads it has nothing to act on and can only be
 * handed bytes it must not repeat. A group invite wakes a turn, but with one fixed
 * sentence in place of the inviter's text.
 */

/**
 * Consume a frame the model never sees: acknowledge it and report that no turn is
 * owed. `false` leaves the frame to the normal delivery path.
 */
export async function consumeHiddenFrame(
	msg: RineInbound,
	acknowledge: (id: string) => Promise<void>,
): Promise<boolean> {
	if (!isHiddenFromModel(msg.type)) return false;
	await acknowledge(msg.id);
	return true;
}

/**
 * The whole wake text for a group invite, or undefined for any other type. It names
 * the inviter and the tool that lists pending invites, and nothing the inviter wrote.
 */
export function inviteWakeText(msg: RineInbound): string | undefined {
	return isGroupInvite(msg.type) ? groupInviteNotice(msg.fromHandle) : undefined;
}
