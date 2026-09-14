import { isPermanent } from "@rine-network/core";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { SETASIDE_MAX_ENTRIES } from "./constants.js";
import type { SetAsideEntry, SetAsideReason } from "./setaside-words.js";
import { readSidecar, writeSidecar } from "./sidecar.js";
import type { SidecarLoc } from "./sidecar.js";

export * from "./setaside-words.js";

/**
 * The durable list of messages this agent could not open. The bounded retry
 * that later opens them is `setaside-sweep.ts`.
 *
 * The gap this closes: before it, `dispatch.ts` marked every inbound delivered
 * whether or not this agent's keys could open it. A group message whose sender
 * key had not arrived yet was handed to the harness as an envelope the model
 * could not read, and then consumed — so it left `status=new`, left `/poll` and
 * left the SSE catch-up, and nothing anywhere got it back. OpenClaw had no
 * store, no bound and no runtime signal; this is the store.
 *
 * 🔴 **Nothing in this module acks a row.** Not a record, not the attempt bound,
 * not an overflow drop. The server row stays `new` for as long as it is unread,
 * which is what keeps a message the automatic retry gives up on still visible to
 * `rine_inbox` and still readable by `rine_read`. Acking it would delete exactly
 * the row the inbox listing now deliberately leaves behind: `rine_inbox` marks
 * only the rows it could actually decrypt.
 *
 * Best-effort throughout, like every sidecar here: a set-aside list that cannot
 * be read or written costs a message its AUTOMATIC retry and nothing else.
 */

function loc(configDir: string, agentId: string): SidecarLoc {
	return { configDir, prefix: "setaside", agentId };
}

/**
 * This agent's set-aside list, oldest entry first.
 *
 * Every entry is validated field by field: the file is 0600 in the agent's own
 * config dir rather than attacker-controlled input, but a torn write or a
 * downgrade must degrade to "fewer entries" and never to a throw on the inbound
 * path. A `reason` the running build does not know is kept as written — it only
 * ever reaches a log line, and dropping the entry would throw away a live retry.
 */
export function loadSetAside(
	configDir: string,
	agentId: string,
	logger?: PluginLogger,
): SetAsideEntry[] {
	const raw = readSidecar<unknown>(loc(configDir, agentId), logger);
	if (!Array.isArray(raw)) return [];
	return raw.filter(isEntry).sort((a, b) => a.firstSeen - b.firstSeen);
}

function isEntry(value: unknown): value is SetAsideEntry {
	if (typeof value !== "object" || value === null) return false;
	const e = value as Record<string, unknown>;
	return (
		typeof e.id === "string" &&
		e.id !== "" &&
		typeof e.reason === "string" &&
		typeof e.attempts === "number" &&
		typeof e.firstSeen === "number" &&
		(e.lastTried === null || typeof e.lastTried === "number") &&
		typeof e.exhausted === "boolean"
	);
}

/** Replace this agent's list, trimmed to {@link SETASIDE_MAX_ENTRIES}. */
export function saveSetAside(
	configDir: string,
	agentId: string,
	entries: SetAsideEntry[],
	logger?: PluginLogger,
): void {
	writeSidecar(loc(configDir, agentId), trim(entries), logger);
}

/** What {@link recordSetAside} did, for a caller deciding whether to say so. */
export interface SetAsideRecord {
	/** The entry as it now stands on disk. */
	readonly entry: SetAsideEntry;
	/**
	 * True when this call created the entry rather than refreshing one.
	 *
	 * 🔴 Carried because `entry.exhausted` cannot answer it and a caller that
	 * guesses gets one case exactly wrong: a PERMANENT verdict is recorded
	 * already-exhausted, so "log it unless it is exhausted" silences the first
	 * sighting of the one class of unreadable message that will never be retried
	 * and never be mentioned again.
	 */
	readonly firstSighting: boolean;
}

/**
 * Set one message aside, or refresh the entry it already has.
 *
 * Idempotent on purpose: the in-session dedupe Set is cleared hourly and lost on
 * restart, so a still-unreadable row is re-probed and lands here again. That
 * re-record must NOT count as an attempt — only the sweep's own re-read does,
 * which is what keeps the bound a count of RETRIES rather than a count of polls.
 * `firstSeen` and `attempts` survive, and `exhausted` is sticky: a give-up is
 * never undone by another sighting of the same unreadable bytes.
 *
 * 🔴 It takes the VERDICT, not a `reason` string beside a `permanent` boolean,
 * and asks `rine-core`'s {@link isPermanent} itself. A caller cannot assert a
 * permanence that contradicts the verdict it is recording, and a new `Unreadable`
 * arm gets its answer from the package that defines the arm rather than from
 * whichever connector notices first. `reason` is the verdict's `kind`, which is
 * all a log line ever wanted.
 *
 * Returns {@link SetAsideRecord} so a caller can keep its log line to a first
 * sighting or to an entry still being retried.
 */
export function recordSetAside(
	configDir: string,
	agentId: string,
	id: string,
	verdict: SetAsideReason,
	logger?: PluginLogger,
): SetAsideRecord {
	const entries = loadSetAside(configDir, agentId, logger);
	const found = entries.find((e) => e.id === id);
	const entry: SetAsideEntry = {
		id,
		reason: verdict.kind,
		attempts: found?.attempts ?? 0,
		firstSeen: found?.firstSeen ?? Date.now(),
		lastTried: found?.lastTried ?? null,
		exhausted: isPermanent(verdict) || (found?.exhausted ?? false),
	};
	saveSetAside(
		configDir,
		agentId,
		found ? entries.map((e) => (e.id === id ? entry : e)) : [...entries, entry],
		logger,
	);
	return { entry, firstSighting: found === undefined };
}

/** Forget one entry. The server row is untouched and stays `new`. */
export function dropSetAside(
	configDir: string,
	agentId: string,
	id: string,
	logger?: PluginLogger,
): void {
	const entries = loadSetAside(configDir, agentId, logger);
	if (!entries.some((e) => e.id === id)) return;
	saveSetAside(
		configDir,
		agentId,
		entries.filter((e) => e.id !== id),
		logger,
	);
}

/**
 * Oldest-first overflow eviction: an `exhausted` entry before a live one.
 *
 * The exhausted one is already never retried, so all it loses is being listable;
 * a live entry losing its place loses a retry that could still have opened the
 * message. 🔴 Neither loses the MESSAGE — the row was never marked delivered.
 */
function trim(entries: SetAsideEntry[]): SetAsideEntry[] {
	let over = entries.length - SETASIDE_MAX_ENTRIES;
	if (over <= 0) return entries;
	const byAge = [...entries].sort((a, b) => a.firstSeen - b.firstSeen);
	const doomed = new Set<SetAsideEntry>();
	for (const e of byAge) {
		if (over === 0) break;
		if (e.exhausted) {
			doomed.add(e);
			over -= 1;
		}
	}
	for (const e of byAge) {
		if (over === 0) break;
		if (!doomed.has(e)) {
			doomed.add(e);
			over -= 1;
		}
	}
	return entries.filter((e) => !doomed.has(e));
}
