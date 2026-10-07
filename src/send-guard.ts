/**
 * Repeat-send guard: the pure decision logic behind the `before_tool_call` hook
 * (`send-guard-hook.ts`). No host types, so vitest drives it directly.
 *
 * A weak model can call `rine_send` dozens of times with byte-identical arguments inside ONE
 * run; every call is a fresh message and a fresh conversation on the server. The scope that
 * bounds "the same turn" is the host's `runId` — `sessionKey` is constant across turns, so it
 * cannot serve.
 *
 * A call's record is provisional. It blocks an identical call from the moment the call is
 * allowed through (so parallel identical calls collapse), and stays for good once the call
 * succeeds. A call that fails or never runs is released via `settle`, so the identical retry a
 * model makes after a transient error still goes out.
 *
 * Releasing is safe as long as the idempotency key this guard sets reaches the server: it is
 * fixed for the call's guard key within the run. (Another plugin whose `before_tool_call`
 * rewrites params after ours would drop it; see `send-guard-hook.ts`.) The host cannot tell "failed before the POST" from
 * "delivered, then errored" (a thrown reply-open after the POST, a host timeout, a delivered
 * conversation whose status reads `failed`), so a released retry may follow a message that did go
 * out; the server answers that retry with the original message instead of sending a second.
 */

import { createHash } from "node:crypto";

/** The tools whose identical repeat inside one run is never intended. */
export const GUARDED_SEND_TOOLS: ReadonlySet<string> = new Set(["rine_send", "rine_send_and_wait"]);

/**
 * A model key the guard will carry: printable ASCII, at most 255 characters (the server's cap),
 * with inner spaces allowed but none at either end, since fetch trims a header value and the
 * server would then see a different key. Anything else is replaced by the derived key.
 */
const USABLE_IDEMPOTENCY_KEY = /^[\x21-\x7e](?:[\x20-\x7e]{0,253}[\x21-\x7e])?$/;

/** Params that differ between otherwise identical calls without making them different messages. */
const IGNORED_KEY_PARAMS: ReadonlySet<string> = new Set(["idempotency_key"]);

/**
 * How long a run's record survives without a guarded call. A run lasts minutes; this bounds the
 * map on hosts where no end-of-run signal reaches us (`agent_end` is gated behind an operator
 * opt-in for non-bundled plugins, so it cannot be relied on).
 */
export const SEND_GUARD_RUN_TTL_MS = 30 * 60_000;

/** Hard ceiling on tracked runs, applied after the TTL sweep. */
export const SEND_GUARD_MAX_RUNS = 256;

/** What the model reads on a blocked repeat. A result, not an error: an error invites a retry. */
export function alreadySentText(to: unknown): string {
	const target = typeof to === "string" && to.length > 0 ? to : "that recipient";
	return (
		`Already sent: this exact message to ${target} went out earlier in this turn. ` +
		"It was not sent again. Do not send it again; finish your turn."
	);
}

/** JSON with object keys sorted at every depth, so key order never changes the guard key. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function callKey(toolName: string, params: Record<string, unknown>): string {
	const kept = Object.fromEntries(
		Object.entries(params).filter(([k]) => !IGNORED_KEY_PARAMS.has(k)),
	);
	return `${toolName}\u0000${canonicalJson(kept)}`;
}

/** The idempotency key a guarded call sends when the model supplied none: stable per run and call. */
function deriveIdempotencyKey(runId: string, key: string): string {
	return `rine-oc-${createHash("sha256").update(`${runId}\u0000${key}`).digest("hex").slice(0, 32)}`;
}

interface RunRecord {
	/** Every key allowed through and not released, whether its call is still running or has finished. */
	keys: Set<string>;
	/** The idempotency key each guard key was first sent with; kept across a release. */
	idempotencyKeys: Map<string, string>;
	/** toolCallId to key, for calls allowed through and not yet settled. */
	pending: Map<string, string>;
	sessionKey: string | undefined;
	lastSeen: number;
}

export type SendGuardVerdict =
	| { block: true; reason: string }
	/** The call may run; `idempotencyKey` is the one it must carry (the model's own, or a derived one). */
	| { block: false; idempotencyKey: string };

export interface SendGuard {
	/**
	 * Judge one tool call and record it provisionally. Undefined for a tool it does not guard.
	 * Synchronous by design: the host may fire
	 * parallel identical calls in one model step, and only a record made before any await lets
	 * the second one see the first.
	 */
	check(
		runId: string,
		toolName: string,
		params: Record<string, unknown>,
		sessionKey?: string,
		toolCallId?: string,
	): SendGuardVerdict | undefined;
	/**
	 * The host finished a call `check` allowed through. A failed call releases its key so an
	 * identical retry goes through; a successful one keeps blocking. Unknown calls are ignored.
	 */
	settle(runId: string, toolCallId: string, failed: boolean): void;
	/** Drop every record of a session (the host's `session_end`). */
	forgetSession(sessionKey: string): void;
}

export function createSendGuard(now: () => number = Date.now): SendGuard {
	const runs = new Map<string, RunRecord>();

	function sweep(at: number): void {
		for (const [id, rec] of runs) if (at - rec.lastSeen > SEND_GUARD_RUN_TTL_MS) runs.delete(id);
		// Map iterates in insertion order, and a touched run is re-inserted, so the head is the oldest.
		while (runs.size > SEND_GUARD_MAX_RUNS) runs.delete(runs.keys().next().value as string);
	}

	return {
		check(runId, toolName, params, sessionKey, toolCallId) {
			if (!GUARDED_SEND_TOOLS.has(toolName)) return undefined;
			const at = now();
			const rec = runs.get(runId) ?? {
				keys: new Set<string>(),
				idempotencyKeys: new Map<string, string>(),
				pending: new Map<string, string>(),
				sessionKey,
				lastSeen: at,
			};
			runs.delete(runId);
			rec.lastSeen = at;
			runs.set(runId, rec);
			sweep(at);
			const key = callKey(toolName, params);
			if (rec.keys.has(key)) return { block: true, reason: alreadySentText(params.to) };
			rec.keys.add(key);
			if (toolCallId !== undefined) rec.pending.set(toolCallId, key);
			const supplied =
				typeof params.idempotency_key === "string" && USABLE_IDEMPOTENCY_KEY.test(params.idempotency_key)
					? params.idempotency_key
					: "";
			const idempotencyKey =
				rec.idempotencyKeys.get(key) || supplied || deriveIdempotencyKey(runId, key);
			rec.idempotencyKeys.set(key, idempotencyKey);
			return { block: false, idempotencyKey };
		},
		settle(runId, toolCallId, failed) {
			const rec = runs.get(runId);
			const key = rec?.pending.get(toolCallId);
			if (rec === undefined || key === undefined) return;
			rec.pending.delete(toolCallId);
			if (failed) rec.keys.delete(key);
		},
		forgetSession(sessionKey) {
			for (const [id, rec] of runs) if (rec.sessionKey === sessionKey) runs.delete(id);
		},
	};
}
