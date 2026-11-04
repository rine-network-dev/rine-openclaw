import { readSidecar, writeSidecar } from "../sidecar.js";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

/**
 * SSE `Last-Event-ID` cursor, persisted across gateway/service restarts.
 *
 * Without this, `runSseTransport` reseeds `lastEventId` to `undefined` on every start, so
 * the first connect sends no `Last-Event-ID` and the server's catch-up (agent_stream.py)
 * replays the newest 200 rows still new — re-waking the agent for conversations it may already have handled.
 * One tiny per-agent 0600 JSON file beside the rine creds keeps the resume point.
 *
 * The file primitives — the path shape, the atomic 0600 write, the
 * absent-and-corrupt-both-degrade read — live in `../sidecar.ts`, which this file
 * was the sole owner of until `setaside.ts` needed the identical dance. The reason
 * a JSON sidecar rather than OpenClaw's SQLite plugin-KV is recorded there.
 * Best-effort throughout — a missing/corrupt/unwritable cursor degrades to one harmless
 * server replay, never throws.
 */

interface CursorFile {
	lastEventId?: unknown;
}

/** The sidecar kind this file owns; one agent's cursor never collides with its set-aside list. */
const CURSOR_PREFIX = "sse_cursor";

/** Read the persisted Last-Event-ID for an agent, or undefined if absent/corrupt. */
export function loadCursor(
	configDir: string,
	agentId: string,
	logger?: PluginLogger,
): string | undefined {
	const parsed = readSidecar<CursorFile>(
		{ configDir, prefix: CURSOR_PREFIX, agentId },
		logger,
	);
	return typeof parsed?.lastEventId === "string" && parsed.lastEventId !== ""
		? parsed.lastEventId
		: undefined;
}

/** Persist the Last-Event-ID for an agent via an atomic 0600 write. Best-effort. */
export function saveCursor(
	configDir: string,
	agentId: string,
	eventId: string,
	logger?: PluginLogger,
): void {
	writeSidecar(
		{ configDir, prefix: CURSOR_PREFIX, agentId },
		{ lastEventId: eventId },
		logger,
	);
}
