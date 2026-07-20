import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig, PluginLogger, PluginRuntime } from "openclaw/plugin-sdk";
import { type DispatchFn, type DispatchOpts, msgOf } from "./dispatch.js";
import { sendRineReply } from "./outbound.js";
import type { RineClient } from "./rine-client.js";
import type { RineInbound } from "./types.js";

/**
 * The Funnel relay self-sends this type (`from == to`); it is a one-way event the agent ACTS
 * on and must never auto-reply to (the reply is a self-send the server rejects). Compared as a
 * literal so the guard never depends on the installed SDK exporting a named constant — mirrors
 * the rine-hermes `_FUNNEL_WEBHOOK_TYPE` precedent.
 */
const WEBHOOK_TYPE = "rine.v1.webhook";

/**
 * A one-way inbound: a Funnel webhook, or any self-addressed message (`from == to`). The agent
 * wakes to act via tools, but an auto-reply would target itself and be rejected (REQ-FSH-02).
 */
function isOneWayEvent(msg: RineInbound): boolean {
	return msg.type === WEBHOOK_TYPE || msg.selfSend === true;
}

/**
 * The three x402 payment frames: the 402 quote, the signed authorization, and the settlement
 * receipt. Like a one-way event the agent still wakes to ACT (pay via the `rine_pay` tool, read
 * the receipt), but a canned TEXT auto-reply would be injected into the payment thread and
 * corrupt the x402 handshake. Compared as literals so the guard never depends on the installed
 * core SDK exporting `X402_MESSAGE_TYPE` — mirrors the WEBHOOK_TYPE precedent above.
 */
const X402_FRAME_TYPES = new Set([
	"rine.v1.x402_payment_required",
	"rine.v1.x402_payment",
	"rine.v1.x402_receipt",
]);

function isX402Frame(msg: RineInbound): boolean {
	return X402_FRAME_TYPES.has(msg.type);
}

/**
 * The inline pointer body — ciphertext stays out of the transcript; agent calls `rine_read`.
 *
 * The body also binds the reply target to the SENDER. Without this, a model that replies via the
 * optional `rine_send` tool can copy the message's own `to_agent_id` (= this agent's id, surfaced
 * by `rine_read`) and self-target, producing `Unknown target` (TODO-4). The auto-routing path is
 * `rine_reply message_id=<id>`, which derives the recipient from the original sender server-side.
 */
export function pointerText(msg: RineInbound): string {
	return `[rine ${msg.type} from ${msg.fromHandle}] message ${msg.id} (read with rine_read; reply with rine_reply message_id=${msg.id} — it auto-routes to ${msg.fromHandle}. If you use rine_send instead, set to=${msg.fromHandle}, never your own agent id.)`;
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
		let dispatchErr: unknown;
		await dispatchInboundDirectDmWithRuntime({
			cfg,
			runtime,
			channel: "rine",
			channelLabel: "Rine",
			accountId: agentId,
			peer: { kind: "direct", id: peerId },
			senderId: msg.fromHandle,
			senderAddress: msg.fromHandle,
			recipientAddress: agentId,
			conversationLabel: msg.isGroup
				? `rine group ${msg.conversationId}`
				: msg.fromHandle,
			rawBody: pointerText(msg),
			messageId: msg.id,
			timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
			deliver: async (payload) => {
				const text = payload.text ?? "";
				if (!text) {
					// rine replies are text-only; a media-only turn (channel declares
					// media:false, so this is near-unreachable) is dropped — but logged.
					logger.warn(`rine: dropping non-text reply for ${msg.id} (rine replies are text-only)`);
					return;
				}
				// One-way events (Funnel webhook / self-send) and catch-up replays wake the agent
				// to ACT via tools, but must NOT auto-reply: a reply to a self-send is server-rejected
				// (REQ-FSH-02), and replying to a backlog replay fans out spam on restart (REQ-FSH-01).
				if (isOneWayEvent(msg)) {
					logger.debug?.(
						`rine: no auto-reply for one-way ${msg.type} ${msg.id} (act via tools; reply would target self)`,
					);
					return;
				}
				if (isX402Frame(msg)) {
					logger.debug?.(
						`rine: no auto-reply for x402 frame ${msg.type} ${msg.id} (act via the rine_pay tool; a text reply would corrupt the payment handshake)`,
					);
					return;
				}
				if (opts?.replayed) {
					logger.debug?.(
						`rine: no auto-reply for catch-up/replayed ${msg.id} (live-phase frames only)`,
					);
					return;
				}
				await replyToRine(client, msg, text, logger);
			},
			onRecordError: (err) =>
				logger.warn(`rine: session-record error for ${msg.id}: ${msgOf(err)}`),
			onDispatchError: (err) => {
				dispatchErr = err;
			},
		});
		if (dispatchErr) throw dispatchErr; // preserve at-least-once: makeOnMessage retries.
	};
}

async function replyToRine(
	client: RineClient,
	msg: RineInbound,
	text: string,
	logger: PluginLogger,
): Promise<void> {
	if (!text) return;
	try {
		await sendRineReply(client, msg, text);
	} catch (err) {
		logger.error(`rine: outbound reply failed for ${msg.id}: ${msgOf(err)}`);
	}
}
