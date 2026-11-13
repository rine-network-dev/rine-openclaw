import { type MessageRead, RineApiError, withPeekHeader } from "@rine-network/core";
import { streamConnectedLine } from "../constants.js";
import type { DispatchOpts } from "../dispatch.js";
import { normalizeRineEvent } from "../inbound.js";
import { backoff, sleep } from "./backoff.js";
import { isFreshCatchup } from "./catchup.js";
import type { TransportContext } from "./context.js";
import { loadCursor, saveCursor } from "./cursor.js";
import { parseSseBlock, readWithIdleWatchdog } from "./sse-frames.js";
import { SUSPENDED_RETRY_MS, isHold, streamRefusal, suspensionLog } from "./suspended.js";

const MAX_ATTEMPTS_BEFORE_FALLBACK = 5;

/**
 * SSE transport — the safe default. Holds an authenticated outbound stream to
 * `GET /agents/{id}/stream?persistent=true`, resumes via `Last-Event-ID`, dispatches
 * `event: message` payloads, reconnects with exp-backoff + jitter.
 *
 * Graceful fallback: after repeated connect/stream errors it imports and runs the POLL
 * transport (SSE → poll rung of the ladder). Never crashes the service.
 *
 * A hold (the agent or its branch suspended, its org frozen) is not an error of the stream: the
 * server ends the stream and refuses the next token. It never counts toward the fallback; the
 * transport waits `SUSPENDED_RETRY_MS` and asks again with a fresh token, so a resume needs no
 * restart. A 401 also asks for a fresh token: the cached one died with the hold.
 */
export async function runSseTransport(tc: TransportContext): Promise<void> {
	const { client, config, agentId, logger, onMessage, signal } = tc;
	let attempt = 0;
	let freshToken = false;
	const suspension = suspensionLog(logger);
	// Seed from disk so a gateway/service restart resumes catch-up past the last delivered
	// message instead of replaying the whole history (a cursorless connect re-sends the newest
	// 200 messages still new, never delivered history).
	let lastEventId = loadCursor(client.configDir, agentId, logger);

	while (!signal.aborted) {
		try {
			await streamOnce({
				tc,
				lastEventId,
				freshToken,
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
					freshToken = false;
					suspension.recovered();
				},
				onRaw: async (raw, opts) => onMessage(normalizeRineEvent(raw), opts),
			});
			attempt = 0; // clean close (idle) — reconnect immediately on next loop.
		} catch (err) {
			const held = isHold(err);
			freshToken = held || (err instanceof RineApiError && err.status === 401);
			if (held) {
				suspension.held();
				await pause(SUSPENDED_RETRY_MS, signal);
				continue;
			}
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
			await pause(backoff(attempt, config.reconnectBaseMs, config.reconnectMaxMs), signal);
		}
	}
}

async function pause(delay: number, signal: AbortSignal): Promise<void> {
	try {
		await sleep(delay, signal);
	} catch {
		/* aborted */
	}
}

async function streamOnce(params: {
	tc: TransportContext;
	lastEventId: string | undefined;
	/** Mint a new token rather than reuse the cached one. */
	freshToken: boolean;
	onDelivered: (id: string) => void;
	onReset: () => void;
	/** Dispatch one message: true = delivered (cursor may advance), false = dispatch failed. */
	onRaw: (raw: MessageRead, opts: DispatchOpts) => Promise<boolean>;
}): Promise<void> {
	const { tc, lastEventId, freshToken, onDelivered, onReset, onRaw } = params;
	const { client, agentId, logger, signal } = tc;
	const jwt = await client.getJwt(freshToken || undefined);
	// Peek: the server does not mark a row delivered when it streams it. `dispatch.ts` acks
	// each row once it has settled, so a failed dispatch, a quarantined sender or a set-aside
	// row stays new and is re-sent on reconnect.
	const headers = withPeekHeader<Record<string, string>>({
		Authorization: `Bearer ${jwt}`,
		Accept: "text/event-stream",
	}, true);
	if (lastEventId) headers["Last-Event-ID"] = lastEventId;

	const url = `${client.apiUrl}/agents/${agentId}/stream?persistent=true`;
	const res = await fetch(url, { headers, signal });
	if (!res.ok || !res.body) throw await streamRefusal(res);
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
	// past the last DELIVERED message (one this plugin acked after it settled), so its catch-up
	// (agent_stream.py Phase 1) is bounded to genuinely-new messages — those SHOULD auto-reply, so we start live. Only a
	// cursorless connect (first-ever boot / lost cursor) can replay an unbounded backlog, so it
	// starts in catch-up (no auto-reply) and flips to live on the first heartbeat/status frame.
	// One exception: a catch-up frame minutes old (`isFreshCatchup`) is a real, unanswered message,
	// e.g. one sent before the agent's first-ever connect, so it is dispatched live.
	// Acked history is never re-streamed (cursor + server catch-up of rows still new), so this
	// never fans out canned replies to a delivered backlog on restart.
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
