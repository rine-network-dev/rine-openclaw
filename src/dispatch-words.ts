import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { RineClient } from "./rine-client.js";
import type { RineConfig, RineInbound } from "./types.js";

/**
 * The inbound path's vocabulary: what a transport hands `onMessage`, what
 * `onMessage` hands the harness, and what the factory needs to build one.
 *
 * Split out of `dispatch.ts` for the file-size budget, on the same terms as this
 * package's other `*-words.ts` (`setaside-words.ts`) — no I/O, no crypto, no
 * client, nothing that can fail, and every import type-only. The control flow is
 * next door; this file is only what the pieces are called, and it is re-exported
 * from there so no caller has to know the split happened.
 */

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
	 * This frame arrived during the SSE catch-up phase (before the stream reached the
	 * live/heartbeat state) and is older than `FRESH_CATCHUP_WINDOW_MS` — wake the agent to
	 * ACT, but never auto-reply. A restart against a stale undelivered backlog would otherwise
	 * fan out one canned reply per replayed message. Live-phase frames and catch-up frames
	 * inside the fresh window (opts absent / `replayed:false`) still auto-reply.
	 */
	replayed?: boolean;
}

/**
 * What `makeOnMessage` is built from.
 *
 * 🔴 `signal` is a LIFETIME, not just a cancellation token for one dispatch: it
 * bounds the retry timer the factory starts (`setaside-schedule.ts`). A caller
 * that never aborts it leaves that timer running.
 */
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
 * quarantined, or set aside for retry) so the SSE cursor may advance past it; `false` only
 * when dispatch FAILED — a transient error that must be retried, so the cursor must stay
 * behind it.
 */
export type OnMessage = (msg: RineInbound, opts?: DispatchOpts) => Promise<boolean>;
