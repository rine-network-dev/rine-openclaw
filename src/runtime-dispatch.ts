import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { DispatchFn, DispatchOpts } from "./dispatch.js";
import { deliverTurn, type AnswerRoute } from "./deliver-turn.js";
import { msgOf } from "./err.js";
import type { RineClient } from "./rine-client.js";
import { forgetSilentTurn } from "./silent-turn-hook.js";
import type { RineInbound } from "./types.js";

/**
 * Types the agent still WAKES for — it acts on them through its tools — but must never
 * auto-reply to, each mapped to the reason the operator reads in the log. Compared as
 * literals so a guard never depends on the installed SDK exporting a named constant
 * (mirrors the rine-hermes `_FUNNEL_WEBHOOK_TYPE` precedent).
 *
 * The Funnel webhook is relayed as the agent itself (`from == to`), so a reply targets the
 * agent and the server rejects it. The three x402 frames carry a payment handshake, and a
 * canned text reply injected into that thread corrupts it. The sender-key distribution and
 * group-invite envelopes are control frames whose payload the recipient parses as JSON:
 * a text answer to one is prose the peer's ingest path has to throw away, and because
 * `rine_reply` mirrors the inbound type the answer also goes on the wire wearing the
 * control frame's own label.
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
function noAutoReplyReason(
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
	return undefined;
}

/**
 * How an answer to `msg` reaches its audience, or undefined when there is no route.
 *
 * A GROUP is answered by SENDING to the group, never by replying. `POST /messages/{id}/reply`
 * routes to the "other party" of a 1:1 pair and a group row carries `to_agent_id IS NULL` —
 * there is no other party, so the lifted `rine_reply` handler refuses one GET earlier
 * ("Cannot reply to a group post — it has no single recipient. Answer the group by sending
 * to " and then ONE OF TWO tails — `rine-mcp/src/tools/messaging.ts`,
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
function answerRouteOf(msg: RineInbound): AnswerRoute | undefined {
	if (!msg.isGroup) return { kind: "direct", handle: msg.fromHandle };
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
 */
export function pointerText(msg: RineInbound, route?: AnswerRoute): string {
	const inGroup =
		msg.isGroup && msg.groupHandle ? ` in group ${msg.groupHandle}` : "";
	const head = `[rine ${msg.type} from ${msg.fromHandle}${inGroup}] message ${msg.id}`;
	if (!route) {
		return `${head} (read it with rine_read. Nothing you write this turn is sent — act on this message with your tools instead.)`;
	}
	if (route.kind === "group") {
		return `${head} (read it with rine_read, then answer in your turn — your answer is posted to the whole group ${route.handle} automatically. Do not call a send tool, and never answer the sender privately.)`;
	}
	return `${head} (read it with rine_read, then answer in your turn — your answer is delivered back to ${route.handle} automatically. Do not call a send tool to answer.)`;
}

/**
 * Production dispatch fn: wakes an agent turn for one inbound rine message via the
 * canonical `dispatchInboundDirectDmWithRuntime` helper. `api.config` (cfg) and
 * `api.runtime` (the `DirectDmRuntime` facade) are threaded in from the service.
 *
 * Keeps the pointer-body design: `pointerText(msg)` carries only a "read with rine_read"
 * pointer, so ciphertext never enters the transcript.
 */
export function makeRuntimeDispatcher(params: {
	cfg: OpenClawConfig;
	runtime: PluginRuntime;
	client: RineClient;
	agentId: string;
	logger: PluginLogger;
}): DispatchFn {
	const { cfg, runtime, client, agentId, logger } = params;
	return async function dispatch(
		msg: RineInbound,
		signal: AbortSignal,
		opts?: DispatchOpts,
	): Promise<void> {
		signal.throwIfAborted();
		// v0.1: groups ride the direct-DM helper with peer.id = conversationId; native
		// group ChatType is a v0.2 item (no dispatchInboundGroupWithRuntime exists).
		const peerId = msg.isGroup ? msg.conversationId : msg.fromHandle;
		const timestamp = msg.createdAt ? Date.parse(msg.createdAt) : undefined;
		// Resolved once, so the pointer the model reads and the delivery `deliver` performs
		// can never disagree about where (or whether) the answer goes.
		const suppressed = noAutoReplyReason(msg, opts);
		const route = suppressed ? undefined : answerRouteOf(msg);
		const peer = { kind: "direct", id: peerId } as const;
		// The key the host runs this turn under — resolved with the call the dispatch helper
		// makes, so the model-output hook and `deliver` below name the same session.
		const { sessionKey } = runtime.channel.routing.resolveAgentRoute({
			cfg,
			channel: "rine",
			accountId: agentId,
			peer,
		});
		let dispatchErr: unknown;
		// A flag left by a run this plugin did not dispatch must not silence this turn: err toward delivering.
		forgetSilentTurn(sessionKey);
		try {
			await dispatchInboundDirectDmWithRuntime({
				cfg,
				runtime,
				channel: "rine",
				channelLabel: "Rine",
				accountId: agentId,
				peer,
				senderId: msg.fromHandle,
				senderAddress: msg.fromHandle,
				recipientAddress: agentId,
				conversationLabel: msg.isGroup
					? `rine group ${msg.conversationId}`
					: msg.fromHandle,
				rawBody: pointerText(msg, route),
				messageId: msg.id,
				timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
				deliver: (payload) =>
					deliverTurn(payload.text ?? "", {
						msg,
						suppressed,
						route,
						sessionKey,
						client,
						logger,
						agentId,
					}),
				onRecordError: (err) =>
					logger.warn(`rine: session-record error for ${msg.id}: ${msgOf(err)}`),
				onDispatchError: (err) => {
					dispatchErr = err;
				},
			});
		} finally {
			forgetSilentTurn(sessionKey);
		}
		if (dispatchErr) throw dispatchErr; // preserve at-least-once: makeOnMessage retries.
	};
}
