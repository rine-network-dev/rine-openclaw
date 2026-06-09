import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig, PluginLogger, PluginRuntime } from "openclaw/plugin-sdk";
import { isAllowed } from "./inbound.js";
import { sendRineReply } from "./outbound.js";
import type { RineClient } from "./rine-client.js";
import type { RineConfig, RineInbound } from "./types.js";

/**
 * The agent-turn dispatch fn — injected so the dedupe/ordering logic is unit-testable
 * without the SDK. In production it wraps `dispatchInboundDirectDmWithRuntime`
 * (`openclaw/plugin-sdk/channel-inbound`), the canonical inbound→agent-turn helper that
 * routes, finalizes the PascalCase ctx, records the session, and dispatches.
 */
export type DispatchFn = (msg: RineInbound, signal: AbortSignal) => Promise<void>;

export interface OnMessageDeps {
	client: RineClient;
	config: RineConfig;
	agentId: string;
	logger: PluginLogger;
	dispatch: DispatchFn;
	signal: AbortSignal;
}

/**
 * A single inbound → exactly-one agent-turn handler with at-least-once mark-delivered.
 *
 * Returns `true` when the message reached a terminal handled state (delivered, already-seen,
 * or quarantined) so the SSE cursor may advance past it; `false` only when dispatch FAILED —
 * a transient error that must be retried, so the cursor must stay behind it.
 */
export type OnMessage = (msg: RineInbound) => Promise<boolean>;

function msgOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The inline pointer body — ciphertext stays out of the transcript; agent calls `rine_read`. */
export function pointerText(msg: RineInbound): string {
	return `[rine ${msg.type} from ${msg.fromHandle}] message ${msg.id} (read with rine_read)`;
}

/**
 * Build the shared `onMessage` path all transports converge on.
 *
 * Invariants (acceptance §6):
 *  - dedupe by rine message id (Set, add-id-BEFORE-await race guard; delete-on-error
 *    so a failed dispatch is retried; hourly clear bounds memory).
 *  - mark-delivered ONLY after a successful dispatch (at-least-once).
 *  - disallowed sender → quarantine (logged exactly once), no dispatch, not marked
 *    delivered (recoverable after the operator fixes allowFrom + restarts the gateway).
 */
export function makeOnMessage(deps: OnMessageDeps): OnMessage {
	const { client, config, agentId, logger, dispatch, signal } = deps;
	const seen = new Set<string>();
	// Quarantined ids are NOT subject to the hourly seen.clear() — log exactly once.
	const quarantined = new Set<string>();
	let lastClear = Date.now();

	function maybeClear(): void {
		if (Date.now() - lastClear > 3_600_000) {
			seen.clear();
			lastClear = Date.now();
		}
	}

	return async function onMessage(msg: RineInbound): Promise<boolean> {
		maybeClear();
		if (seen.has(msg.id)) return true; // already handled this session — not a gap.

		if (isAllowed(msg.fromHandle, config.allowFrom) === "quarantined") {
			if (!quarantined.has(msg.id)) {
				quarantined.add(msg.id);
				logger.warn(
					`rine: quarantined message ${msg.id} from disallowed sender "${msg.fromHandle}" (allowFrom=${config.allowFrom.join(",")}; allowFrom changes take effect on gateway restart)`,
				);
			}
			// Terminally filtered (logged once; still server-retrievable via the tools). Advance
			// the cursor past it so a disallowed sender can't pin/replay the stream every restart.
			return true;
		}

		// Observability: one structured INFO line per fresh inbound (deduped replays and
		// quarantined senders never reach here). Agent turns themselves log only at debug.
		logger.info(`rine: inbound ${msg.type} ${msg.id} from ${msg.fromHandle} → dispatching`);
		seen.add(msg.id); // BEFORE await — race guard against concurrent delivery.
		try {
			await dispatch(msg, signal);
		} catch (err) {
			seen.delete(msg.id); // re-eligible on next delivery.
			logger.error(`rine: dispatch failed for ${msg.id}: ${msgOf(err)}`);
			return false; // do NOT mark delivered or advance the cursor — retried on next delivery.
		}

		try {
			await client.markDelivered(agentId, [msg.id]);
		} catch (err) {
			logger.warn(
				`rine: mark-delivered failed for ${msg.id} (already dispatched): ${msgOf(err)}`,
			);
		}
		return true;
	};
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
	return async function dispatch(msg: RineInbound, signal: AbortSignal): Promise<void> {
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
