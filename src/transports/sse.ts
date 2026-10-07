import type { MessageRead } from "@rine-network/core";
import { streamConnectedLine } from "../constants.js";
import type { DispatchOpts } from "../dispatch.js";
import { normalizeRineEvent } from "../inbound.js";
import { backoff, sleep } from "./backoff.js";
import { isFreshCatchup } from "./catchup.js";
import type { TransportContext } from "./context.js";
import { loadCursor, saveCursor } from "./cursor.js";
import { parseSseBlock, readWithIdleWatchdog } from "./sse-frames.js";

const MAX_ATTEMPTS_BEFORE_FALLBACK = 5;

/**
 * SSE transport — the safe default. Holds an authenticated outbound stream to
 * `GET /agents/{id}/stream?persistent=true`, resumes via `Last-Event-ID`, dispatches
 * `event: message` payloads, reconnects with exp-backoff + jitter.
 *
 * Graceful fallback: after repeated connect/stream errors it imports and runs the POLL
 * transport (SSE → poll rung of the ladder). Never crashes the service.
 */
export async function runSseTransport(tc: TransportContext): Promise<void> {
	const { client, config, agentId, logger, onMessage, signal } = tc;
	let attempt = 0;
	// Seed from disk so a gateway/service restart resumes catch-up past the last delivered
	// message instead of replaying the whole history (a cursorless connect yields the newest
	// 200 undelivered messages, never delivered history).
	let lastEventId = loadCursor(client.configDir, agentId, logger);

	while (!signal.aborted) {
		try {
			await streamOnce({
				tc,
				lastEventId,
				// Advance the resume point ONLY for messages that actually dispatched. Persisting
				// at parse time would skip a dispatch-failed message forever — the server's catch-up
				// is created_at-based and never reconsults delivery state, so a cursor past message M
				// makes M unreachable, defeating the at-least-once retry makeOnMessage relies on.
				onDelivered: (id) => {
					lastEventId = id;
					saveCursor(client.configDir, agentId, id, logger);
				},
				onReset: () => {
					attempt = 0;
				},
				onRaw: async (raw, opts) => onMessage(normalizeRineEvent(raw), opts),
			});
			attempt = 0; // clean close (idle) — reconnect immediately on next loop.
		} catch (err) {
			attempt += 1;
			logger.warn(
				`rine: SSE stream error (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`,
			);
			if (attempt >= MAX_ATTEMPTS_BEFORE_FALLBACK) {
				logger.warn("rine: SSE failed repeatedly — falling back to POLL transport");
				const { runPollTransport } = await import("./poll.js");
				await runPollTransport(tc);
				return;
			}
			await waitBackoff(attempt, config, signal);
		}
	}
}

async function waitBackoff(
	attempt: number,
	config: TransportContext["config"],
	signal: AbortSignal,
): Promise<void> {
	const delay = backoff(attempt, config.reconnectBaseMs, config.reconnectMaxMs);
	try {
		await sleep(delay, signal);
	} catch {
		/* aborted */
	}
}

async function streamOnce(params: {
	tc: TransportContext;
	lastEventId: string | undefined;
	onDelivered: (id: string) => void;
	onReset: () => void;
	/** Dispatch one message: true = delivered (cursor may advance), false = dispatch failed. */
	onRaw: (raw: MessageRead, opts: DispatchOpts) => Promise<boolean>;
}): Promise<void> {
	const { tc, lastEventId, onDelivered, onReset, onRaw } = params;
	const { client, agentId, logger, signal } = tc;
	const jwt = await client.getJwt();
	const headers: Record<string, string> = {
		Authorization: `Bearer ${jwt}`,
		Accept: "text/event-stream",
	};
	if (lastEventId) headers["Last-Event-ID"] = lastEventId;

	const url = `${client.apiUrl}/agents/${agentId}/stream?persistent=true`;
	const res = await fetch(url, { headers, signal });
	if (!res.ok || !res.body) {
		throw new Error(`stream HTTP ${res.status}`);
	}
	onReset(); // connected — reset backoff.

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	// Freeze the cursor at the last *contiguously*-delivered id: once a message fails to
	// dispatch, later successes in THIS stream must not advance past the gap, so the server
	// replays from the failed message (not past it) on the next reconnect — at-least-once.
	let gapSeen = false;
	// Catch-up vs live phase. The server (agent_stream.py) emits a heartbeat at the
	// catch-up→live boundary (PROTOCOL.md §7.4); older servers emitted none, so there
	// "first heartbeat/status = live" is unreliable: a live DM that arrives before the first
	// idle-driven heartbeat (and, on a busy `persistent=true` stream, EVERY DM, since the queue
	// never idles 30s) would be mis-tagged as a replay and never auto-reply. The reliable
	// signal on every server is the cursor: a cursor-bearing connect resumes precisely
	// past the last DELIVERED message, so its catch-up (agent_stream.py Phase 1) is bounded to
	// genuinely-new, undelivered messages — those SHOULD auto-reply, so we start live. Only a
	// cursorless connect (first-ever boot / lost cursor) can replay an unbounded backlog, so it
	// starts in catch-up (no auto-reply) and flips to live on the first heartbeat/status frame.
	// One exception: a catch-up frame minutes old (`isFreshCatchup`) is a real, unanswered message,
	// e.g. one sent before the agent's first-ever connect, so it is dispatched live.
	// Already-delivered history is never re-streamed (cursor + server undelivered-only catch-up),
	// so this never fans out canned replies to a delivered backlog on restart.
	let live = lastEventId !== undefined;
	let announced = false; // "stream connected" is logged once per connection.
	// The server loads the catch-up set once, when the stream opens. Judge every catch-up frame's
	// age against that moment: each frame waits for the previous one's whole agent turn, so
	// judging at dispatch would age the tail of a burst out of the fresh window.
	const openedAt = Date.now();
	while (!signal.aborted) {
		const { done, value } = await readWithIdleWatchdog(reader);
		if (done) return;
		buffer += decoder.decode(value, { stream: true });
		let sep: number;
		while ((sep = buffer.indexOf("\n\n")) !== -1) {
			const block = buffer.slice(0, sep);
			buffer = buffer.slice(sep + 2);
			const evt = parseSseBlock(block);
			if (!evt) continue;
			// The stream is up once any frame parses. Announce before that frame is dispatched: a
			// catch-up frame's turn can outlast the fleet's wait for this line.
			if (!announced) {
				announced = true;
				logger.info(streamConnectedLine("sse", agentId));
			}
			// A heartbeat/status frame only appears in the live phase — it marks the end of
			// catch-up. Flip to live; these frames carry no message to dispatch.
			if (evt.event === "heartbeat" || evt.event === "status") {
				live = true;
				continue;
			}
			// Only message frames carry an id + dispatch.
			if (evt.event !== "message" || !evt.data) continue;
			let delivered = false;
			try {
				const raw = JSON.parse(evt.data) as MessageRead;
				delivered = await onRaw(raw, { replayed: !live && !isFreshCatchup(raw.created_at, openedAt) });
			} catch {
				// Unparseable frame. The server only emits well-formed message frames, so this is
				// corruption — but if it carried an id, freeze the cursor rather than silently
				// advance past an id-bearing frame we couldn't process (loss > replay for at-least-once).
				if (evt.id) gapSeen = true;
				continue;
			}
			if (delivered && !gapSeen && evt.id) onDelivered(evt.id);
			else if (!delivered) gapSeen = true;
		}
	}
}
