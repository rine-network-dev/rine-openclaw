import type { PluginLogger } from "openclaw/plugin-sdk";
import { isAllowed } from "./inbound.js";
import type { RineClient } from "./rine-client.js";
import type { RineConfig, RineInbound } from "./types.js";

/**
 * The agent-turn dispatch fn — injected so the dedupe/ordering logic is unit-testable
 * without the SDK. In production it wraps `dispatchInboundDirectDmWithRuntime` via
 * `makeRuntimeDispatcher` (`runtime-dispatch.ts`), the canonical inbound→agent-turn
 * helper that routes, finalizes the PascalCase ctx, records the session, and dispatches.
 */
export type DispatchFn = (
	msg: RineInbound,
	signal: AbortSignal,
	opts?: DispatchOpts,
) => Promise<void>;

/**
 * Per-message dispatch modifiers set by the transport (not part of the message itself).
 */
export interface DispatchOpts {
	/**
	 * This frame was replayed during the SSE catch-up phase (before the stream reached the
	 * live/heartbeat state) — wake the agent to ACT, but never auto-reply. A restart against
	 * an undelivered backlog would otherwise fan out one canned reply per replayed message.
	 * Live-phase frames (opts absent / `replayed:false`) still auto-reply.
	 */
	replayed?: boolean;
}

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
export type OnMessage = (msg: RineInbound, opts?: DispatchOpts) => Promise<boolean>;

/** Extract a human message from an unknown throwable (shared with `runtime-dispatch.ts`). */
export function msgOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Build the shared `onMessage` path all transports converge on.
 *
 * Invariants:
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

	return async function onMessage(msg: RineInbound, opts?: DispatchOpts): Promise<boolean> {
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
			await dispatch(msg, signal, opts);
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
