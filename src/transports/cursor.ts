import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk";

/**
 * SSE `Last-Event-ID` cursor, persisted across gateway/service restarts.
 *
 * Without this, `runSseTransport` reseeds `lastEventId` to `undefined` on every start, so
 * the first connect sends no `Last-Event-ID` and the server's catch-up (agent_stream.py)
 * replays the agent's ENTIRE history — re-waking the agent for every old conversation.
 * One tiny per-agent 0600 JSON file beside the rine creds keeps the resume point.
 *
 * A JSON sidecar (not OpenClaw's SQLite plugin-KV) is correct here: rine is an external
 * plugin with no SDK KV/state seam (`api.runContext` is run-scoped, cleared on run end), and
 * it already stores `credentials.json`/`token_cache.json` flat in this same configDir.
 * Best-effort throughout — a missing/corrupt/unwritable cursor degrades to one harmless
 * server replay, never throws.
 */

interface CursorFile {
	lastEventId?: unknown;
}

/** Per-agent cursor path; agentId is sanitized so an operator-typed handle can't escape configDir. */
function cursorPath(configDir: string, agentId: string): string {
	const stem = (agentId || "default").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
	return join(configDir, `sse_cursor_${stem}.json`);
}

function msgOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Read the persisted Last-Event-ID for an agent, or undefined if absent/corrupt. */
export function loadCursor(
	configDir: string,
	agentId: string,
	logger?: PluginLogger,
): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(cursorPath(configDir, agentId), "utf-8")) as CursorFile;
		return typeof parsed.lastEventId === "string" && parsed.lastEventId !== ""
			? parsed.lastEventId
			: undefined;
	} catch (err) {
		// ENOENT (first run / never delivered) is the normal path — only log real read/parse errors.
		if ((err as { code?: string }).code !== "ENOENT") {
			logger?.debug?.(`rine: cursor load failed (${msgOf(err)}) — resuming without it`);
		}
		return undefined;
	}
}

/** Persist the Last-Event-ID for an agent via an atomic 0600 write. Best-effort. */
export function saveCursor(
	configDir: string,
	agentId: string,
	eventId: string,
	logger?: PluginLogger,
): void {
	const path = cursorPath(configDir, agentId);
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
		writeFileSync(tmp, JSON.stringify({ lastEventId: eventId }), { mode: 0o600 });
		renameSync(tmp, path);
		chmodSync(path, 0o600);
	} catch (err) {
		logger?.debug?.(`rine: cursor save failed for ${eventId} (${msgOf(err)})`);
	}
}
