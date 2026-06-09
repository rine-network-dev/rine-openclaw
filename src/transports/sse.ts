import type { MessageRead } from "@rine-network/core";
import { normalizeRineEvent } from "../inbound.js";
import { backoff, sleep } from "./backoff.js";
import type { TransportContext } from "./context.js";
import { loadCursor, saveCursor } from "./cursor.js";

const MAX_ATTEMPTS_BEFORE_FALLBACK = 5;
/** ~3× the server heartbeat (~30s): no bytes for this long => dead socket, reconnect. */
const IDLE_TIMEOUT_MS = 90_000;

interface SseEvent {
	event: string;
	id?: string;
	data: string;
}

/** Parse a complete SSE event block (lines split on `\n`). */
export function parseSseBlock(block: string): SseEvent | undefined {
	let event = "message";
	let id: string | undefined;
	const dataLines: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith(":")) continue; // comment
		const idx = line.indexOf(":");
		const field = idx === -1 ? line : line.slice(0, idx);
		const value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");
		if (field === "event") event = value;
		else if (field === "id") id = value;
		else if (field === "data") dataLines.push(value);
	}
	if (dataLines.length === 0 && !id) return undefined;
	return { event, id, data: dataLines.join("\n") };
}

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
	// message instead of replaying the whole history (server yields ALL messages with no cursor).
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
				onRaw: async (raw) => onMessage(normalizeRineEvent(raw)),
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
	onRaw: (raw: MessageRead) => Promise<boolean>;
}): Promise<void> {
	const { tc, lastEventId, onDelivered, onReset, onRaw } = params;
	const { client, agentId, signal } = tc;
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
	while (!signal.aborted) {
		const { done, value } = await readWithIdleWatchdog(reader);
		if (done) return;
		buffer += decoder.decode(value, { stream: true });
		let sep: number;
		while ((sep = buffer.indexOf("\n\n")) !== -1) {
			const block = buffer.slice(0, sep);
			buffer = buffer.slice(sep + 2);
			const evt = parseSseBlock(block);
			// Only message frames carry an id + dispatch; heartbeat/status frames are no-ops.
			if (!evt || evt.event !== "message" || !evt.data) continue;
			let delivered = false;
			try {
				delivered = await onRaw(JSON.parse(evt.data) as MessageRead);
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

/**
 * `reader.read()` with an idle watchdog: if no chunk arrives within `IDLE_TIMEOUT_MS`,
 * cancel the reader and throw so the reconnect loop takes over (a silently-dead socket
 * never surfaces a `done`). Resets on every chunk because each call starts a fresh timer.
 */
async function readWithIdleWatchdog(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const idle = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			void reader.cancel().catch(() => {});
			reject(new Error(`SSE idle timeout (${IDLE_TIMEOUT_MS}ms, no bytes)`));
		}, IDLE_TIMEOUT_MS);
	});
	try {
		return await Promise.race([reader.read(), idle]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
