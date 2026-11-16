import * as replyChunking from "openclaw/plugin-sdk/reply-chunking";
import type { DispatchOpts } from "./dispatch.js";
import type { RineInbound } from "./types.js";

/**
 * The only inbound types whose turn text is sent back, each mapped to the type the answer
 * wears. Every other type still wakes the agent, but its prose is not sent: text typed as a
 * structured type (a game frame, a receipt, a negotiation step) is garbage to the peer's
 * parser, and not answering `task_response`, `receipt` and `error` removes the ping-pong
 * path. `rine.v1.negotiation` is left out on purpose; the model can answer it with
 * `rine_send --type`. Literals, so the table never depends on the installed SDK exporting a
 * named constant (mirrors the rine-hermes precedent).
 */
const AUTO_ANSWER_TYPES: ReadonlyMap<string, string> = new Map([
	["rine.v1.dm", "rine.v1.dm"],
	["rine.v1.task_request", "rine.v1.task_response"],
	["rine.v1.a2a_message", "rine.v1.a2a_message"],
]);

/** The type an answer to an inbound of `type` is sent as; every answered type has one. */
export function replyTypeFor(type: string): string | undefined {
	return AUTO_ANSWER_TYPES.get(type);
}

/**
 * Types the agent still WAKES for — it acts on them through its tools — but must never
 * auto-reply to, each mapped to the reason the operator reads in the log.
 *
 * The Funnel webhook is relayed as the agent itself (`from == to`), so a reply targets the
 * agent and the server rejects it. The three x402 frames carry a payment handshake, and a
 * canned text reply injected into that thread corrupts it. The sender-key distribution and
 * group-invite envelopes are control frames whose payload the recipient parses as JSON.
 * These specific reasons are tested ahead of the allowlist so their log lines stay as they were.
 */
const NO_AUTO_REPLY_TYPES = new Map<string, string>([
	[
		"rine.v1.webhook",
		"one-way Funnel webhook — act via tools; a reply would target self",
	],
	[
		"rine.v1.x402_payment_required",
		"x402 frame — act via the rine_pay tool; a text reply would corrupt the payment handshake",
	],
	[
		"rine.v1.x402_payment",
		"x402 frame — act via the rine_pay tool; a text reply would corrupt the payment handshake",
	],
	[
		"rine.v1.x402_receipt",
		"x402 frame — act via the rine_pay tool; a text reply would corrupt the payment handshake",
	],
	[
		"rine.v1.sender_key_distribution",
		"sender-key control frame — the peer parses it as JSON, and a text answer would be typed as one",
	],
	[
		"rine.v1.group_invite",
		"group-invite control frame — the peer parses it as JSON, and a text answer would be typed as one",
	],
]);

/** Why this inbound must not be auto-answered, or undefined when an answer is correct. */
export function noAutoReplyReason(
	msg: RineInbound,
	opts?: DispatchOpts,
): string | undefined {
	// A self-addressed message of any type: the reply would target this agent, and the
	// server refuses it ("Cannot reply to your own message").
	if (msg.selfSend === true)
		return "self-addressed message — a reply would target self";
	const byType = NO_AUTO_REPLY_TYPES.get(msg.type);
	if (byType) return byType;
	// Answering a backlog replay fans out one canned reply per queued message on restart.
	if (opts?.replayed) return "catch-up/replayed frame — live-phase frames only";
	if (!AUTO_ANSWER_TYPES.has(msg.type))
		return `${msg.type} is not a chat type — act via tools; prose would be typed as it`;
	return undefined;
}

/**
 * `NO_REPLY` first on its line (after edge punctuation or emphasis), then a separator or the
 * end of the text. `NO_REPLY\n<answer>` and `NO_REPLY<glued text>` do not match: upstream
 * strips the token there and delivers the rest, and so does this plugin.
 */
const LEADING_SILENT_TOKEN = /^[^\p{L}\p{N}]*NO_REPLY[*~`"']*(?:[^\S\r\n]*[—–\-:;,.(]|[^\S\r\n]*$)/iu;

/** The two upstream predicates this plugin reads; the first is absent on older hosts. */
interface UpstreamSilentPredicates {
	isSilentReplyPayloadText?: (text: string) => boolean;
	isSilentReplyText: (text: string) => boolean;
}

/** Upstream's widest silent-text predicate the host exports, else its token-only one. */
export function upstreamSilentPredicate(sdk: UpstreamSilentPredicates): (text: string) => boolean {
	return sdk.isSilentReplyPayloadText ?? sdk.isSilentReplyText;
}

// A namespace import, because the peer floor (openclaw >=2026.9.1) predates a verified
// `isSilentReplyPayloadText`, and a missing NAMED ESM import would fail the whole plugin load.
const isUpstreamSilent = upstreamSilentPredicate(replyChunking);

/**
 * Whether the model's answer means "say nothing": upstream's silent forms (token only, JSON
 * envelope, reasoning-prefixed) or a leading `NO_REPLY` followed by an explanation.
 */
export function isSilentAnswer(text: string | undefined): boolean {
	if (!text) return false;
	return isUpstreamSilent(text) || LEADING_SILENT_TOKEN.test(text.trim());
}
