import { type OperatorPin, UNOPENED_VERDICT } from "@rine-network/core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { DispatchFn, DispatchOpts } from "./dispatch.js";
import { deliverTurn, type AnswerRoute } from "./deliver-turn.js";
import { msgOf } from "./err.js";
import type { RineClient } from "./rine-client.js";
import { closeTurn, openTurn } from "./tool-answers.js";
import type { RineInbound } from "./types.js";
import { wakeSender } from "./wake-identity.js";
import { answerRouteOf, pointerText } from "./wake-text.js";

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
	/** The configured operator seat, or `null` when there is none. */
	operator: OperatorPin | null;
}): DispatchFn {
	const { cfg, runtime, client, agentId, logger, operator } = params;
	return async function dispatch(
		msg: RineInbound,
		signal: AbortSignal,
		opts?: DispatchOpts,
	): Promise<void> {
		signal.throwIfAborted();
		// v0.1: groups ride the direct-DM helper with peer.id = conversationId; native
		// group ChatType is a v0.2 item (no dispatchInboundGroupWithRuntime exists).
		// Who the turn is from is decided by the classifier's verdict and the pin; the handle
		// is only a label. An absent verdict is another party, never the operator.
		const verdict = opts?.verdict ?? UNOPENED_VERDICT;
		const sender = wakeSender(msg, verdict, operator);
		const peerId = msg.isGroup ? msg.conversationId : sender.id;
		const timestamp = msg.createdAt ? Date.parse(msg.createdAt) : undefined;
		// Resolved once, so the pointer the model reads and the delivery `deliver` performs
		// can never disagree about where (or whether) the answer goes.
		const suppressed = noAutoReplyReason(msg, opts);
		const route = suppressed ? undefined : answerRouteOf(msg, sender);
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
		// A record left by a run this plugin did not dispatch must not silence this turn: err toward delivering.
		const turn = openTurn(sessionKey, msg.id);
		try {
			await dispatchInboundDirectDmWithRuntime({
				cfg,
				runtime,
				channel: "rine",
				channelLabel: "Rine",
				accountId: agentId,
				peer,
				senderId: sender.id,
				senderAddress: sender.id,
				recipientAddress: agentId,
				conversationLabel: msg.isGroup
					? `rine group ${msg.conversationId}`
					: sender.label,
				rawBody: pointerText(msg, route, { sender, senderClass: verdict.senderClass }),
				messageId: msg.id,
				timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
				deliver: (payload) =>
					deliverTurn(payload.text ?? "", {
						msg,
						suppressed,
						route,
						turn,
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
			closeTurn(turn);
		}
		if (dispatchErr) throw dispatchErr; // preserve at-least-once: makeOnMessage retries.
	};
}
