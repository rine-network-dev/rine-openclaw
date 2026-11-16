import {
	type SenderClass,
	cleanHandle,
	noticeForClass,
	withA2aCleartextNotice,
} from "@rine-network/core";
import { inviteWakeText } from "./control-frame-route.js";
import type { AnswerRoute } from "./deliver-turn.js";
import { wireRowOf } from "./inbound.js";
import { messageMarker } from "./tool-answers.js";
import type { RineInbound } from "./types.js";
import { wakeType } from "./wake-fields.js";
import type { WakeSender } from "./wake-identity.js";

/**
 * Who sent the message, as decided by the plugin and not by the message: the sender the
 * wake line names and the class that picks its closing notice.
 */
export interface WakeFraming {
	sender: WakeSender;
	senderClass: SenderClass;
}

/** The framing of a message nobody vouched for: its sanitised handle, as data. */
function dataFraming(msg: RineInbound): WakeFraming {
	const id = cleanHandle(msg.fromHandle);
	return { sender: { id, label: id }, senderClass: "other" };
}

/**
 * How an answer to `msg` reaches its audience, or undefined when there is no route.
 *
 * A GROUP is answered by SENDING to the group, never by replying. `POST /messages/{id}/reply`
 * routes to the "other party" of a 1:1 pair and a group row carries `to_agent_id IS NULL` —
 * there is no other party, so the lifted `rine_reply` handler refuses one GET earlier
 * ("Cannot reply to a group post — it has no single recipient. Answer the group by sending
 * to " and then ONE OF TWO tails — `rine-mcp/src/tools/messaging-reply.ts`,
 * `replyToGroupRefusal`) and the route behind it refuses too. The tail is the group's OWN
 * handle when the message it just fetched carries one, and otherwise "its own handle: " plus
 * how such a handle is spelled — `GROUP_HANDLE_PARTS`, rine-core's shared clause in
 * `handle-words.ts`, composed rather than retyped. Both tails keep the advice; the second is
 * for the row whose group has no handle to echo, which is the SAME missing handle
 * `answerRouteOf` below returns no route for. Its sibling refusal, "Cannot determine
 * recipient from message", is the NON-group case: a 1:1 row with no `to_agent_id` at all.
 *
 * `isGroup` is true whenever the inbound carries a group handle OR a bare group id, so a
 * group frame can arrive with no handle (a webhook body carrying only `group_id`). There is
 * no route in that case: a group UUID typechecks as a send target and is then encrypted 1:1
 * and rejected server-side, so refusing loudly beats sending something undeliverable.
 */
export function answerRouteOf(msg: RineInbound, sender: WakeSender): AnswerRoute | undefined {
	if (!msg.isGroup) return { kind: "direct", handle: sender.label };
	return msg.groupHandle
		? { kind: "group", handle: msg.groupHandle }
		: undefined;
}

/**
 * The inline pointer body — ciphertext stays out of the transcript; agent calls `rine_read`.
 *
 * The body names only tools this plugin exposes. It used to point at `rine_reply`, which is
 * an INTERNAL tool the host never registers, so every inbound spent a turn on tool calls the
 * runtime answered with `Tool rine_reply not found`. The plugin routes the turn's text out on
 * its own, so the correct instruction is to answer and call nothing.
 *
 * The body also states the audience. On a group post the old text named the poster twice and
 * the group never, i.e. it instructed the model to answer a group by privately DM'ing whoever
 * spoke last. `route` is resolved once by the dispatcher and passed in, so what the model is
 * told matches what `deliver` actually does — absent when the turn is not delivered at all.
 *
 * Every body ends with the notice for its sender class: the data notice for another party,
 * and for the operator its own sentence. A group invite is the one exception to this whole
 * shape: its text is a fixed sentence (`inviteWakeText`) and nothing the inviter wrote.
 *
 * `sender` and `type` are sanitised to the server's character set before they are written
 * into the head, and the operator's label comes from the configured pin: neither the
 * handle nor the type is covered by the sender's signature.
 */
export function pointerText(
	msg: RineInbound,
	route?: AnswerRoute,
	framing: WakeFraming = dataFraming(msg),
): string {
	const { sender, senderClass } = framing;
	const invite = inviteWakeText({ ...msg, fromHandle: sender.id });
	if (invite !== undefined) return invite;
	const inGroup =
		msg.isGroup && msg.groupHandle ? ` in group ${cleanHandle(msg.groupHandle)}` : "";
	// A cleartext A2A message leads with the sentence saying it was not end-to-end encrypted,
	// so the model reads that before it fetches or answers the body.
	const head = withA2aCleartextNotice(
		wireRowOf(msg),
		`[rine ${wakeType(msg.type)} from ${sender.label}${inGroup}] ${messageMarker(msg.id)}`,
	);
	return `${head} ${tailOf(route)} ${noticeForClass(senderClass)}`;
}

const SILENT_SENTENCE = "If it needs no answer, make your whole reply exactly NO_REPLY.";

/** What the model is told to do with the message, by where its answer goes. */
function tailOf(route?: AnswerRoute): string {
	if (!route) {
		return "(read it with rine_read. Nothing you write this turn is sent — act on this message with your tools instead.)";
	}
	if (route.kind === "group") {
		return `(read it with rine_read, then answer in your turn — your answer is posted to the whole group ${cleanHandle(route.handle)} automatically. Do not call a send tool, and never answer the sender privately. ${SILENT_SENTENCE})`;
	}
	return `(read it with rine_read, then answer in your turn — your answer is delivered back to ${cleanHandle(route.handle)} automatically. Do not call a send tool to answer. ${SILENT_SENTENCE})`;
}
