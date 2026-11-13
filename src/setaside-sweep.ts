import {
	ACTING_AGENT_HEADER,
	isCached,
	isPermanent,
	probeReadability,
	withPeekHeader,
} from "@rine-network/core";
import type { MessageRead } from "@rine-network/core";
import { SETASIDE_MAX_ATTEMPTS, SETASIDE_SWEEP_BATCH } from "./constants.js";
import { normalizeRineEvent, readabilityArgsFor } from "./inbound.js";
import {
	dropSetAside,
	groupSyncMayHeal,
	isDispatchable,
	loadSetAside,
	saveSetAside,
} from "./setaside.js";
import type { SetAsideEntry, SetAsideReason } from "./setaside.js";
import { syncGroupForRetry } from "./setaside-sync.js";
import type { GroupSyncContext, SyncedGroups } from "./setaside-sync.js";
import type { RineInbound } from "./types.js";

/**
 * The bounded retry over the set-aside list. The store it reads and writes is
 * `setaside.ts`.
 *
 * 🔴 The re-read PEEKS (`X-Rine-Peek: 1`). Without it the retry would consume
 * the very row the store exists to protect, and the second failure would destroy
 * it. That is connector-internal code deciding for itself, which is exactly what
 * the peek opt-out is for; the inbound gap is closed by a runtime probe rather
 * than by a model-facing peek argument, and the model gains nothing here either.
 *
 * 🔴 A retry is a sync and THEN a decrypt, for the entries a sync could heal
 * (`groupSyncMayHeal`). Before, it re-read the row and tried the same local keys
 * against the same bytes five times, spending the bound on rehearsals of the
 * first attempt. The sync is core's own, reached through `setaside-sync.ts`.
 *
 * Never throws: the read is caught, the sync catches its own, `probeReadability`
 * does not throw by contract, and `deliver` reports a failed turn rather than
 * raising. An inbound message must never be lost to a sweep.
 */

/**
 * Everything the retry sweep needs. `deliver` is the caller's normal path.
 *
 * The client, config dir, agent and log arrive as {@link GroupSyncContext},
 * extended rather than restated: the sync this sweep runs takes exactly those
 * four, and a second declaration is a second place to disagree about the agent.
 */
export interface SweepArgs extends GroupSyncContext {
	/**
	 * Dispatch a healed message down the ordinary route — the same INFO line,
	 * dedupe entry, agent turn and mark-delivered a first-sight message gets.
	 * Injected rather than imported so this module holds the retry policy and
	 * `dispatch.ts` holds the delivery, and so the sweep is testable without one.
	 */
	deliver: (msg: RineInbound) => Promise<boolean>;
}

/**
 * Re-read and re-probe the entries that are still being retried, oldest first,
 * at most {@link SETASIDE_SWEEP_BATCH} of them.
 *
 * 🔴 The bound is per sweep, not per entry: `loadSetAside` sorts by `firstSeen`,
 * so a list longer than one batch is served from its head and the tail keeps its
 * place and its attempt count. Nothing is dropped; what the tail waits for is the
 * head clearing, which {@link SETASIDE_SWEEP_BATCH} spells out.
 */
export async function sweepSetAside(a: SweepArgs): Promise<void> {
	const live = loadSetAside(a.configDir, a.agentId, a.logger).filter(
		(e) => !e.exhausted,
	);
	pruneSealedKeyIds(live);
	if (live.length === 0) return;
	const due = live.slice(0, SETASIDE_SWEEP_BATCH);
	a.logger.debug?.(
		`rine: retrying ${due.length} of ${live.length} set-aside message(s)`,
	);
	// Per SWEEP: one absent sender key seals every message sent under it, so many
	// of this batch's entries share a group, and a sync per entry would ask one
	// question fifty times. Minted per sweep — five minutes on, the answer moved.
	const synced: SyncedGroups = new Set();
	for (const entry of due) await retryOne(a, entry, synced);
}

/**
 * The sender key id each `sealed` entry last waited on, by message id.
 *
 * In memory like the negative cache it feeds: the store holds ids and counters
 * only, so the key id is learnt from the first probe of a process and the entry
 * is skipped from the second sweep on. A restart costs one scan, never a row.
 *
 * 🔴 Bounded by the store, not by a cap of its own: every sweep drops the ids
 * that are no longer retried ({@link pruneSealedKeyIds}), so a row that gave up,
 * was dropped, purged or answered another way takes its entry with it, and the
 * map never holds more than the store's `SETASIDE_MAX_ENTRIES`. No expiry
 * is needed either: an entry older than the cache's TTL asks `isCached` about a
 * key the cache has already forgotten, and the answer is no.
 */
const sealedKeyIds = new Map<string, string>();

/** Forget the key id of every entry the sweep is not going to retry. */
function pruneSealedKeyIds(live: readonly SetAsideEntry[]): void {
	const retried = new Set(live.map((e) => e.id));
	for (const id of sealedKeyIds.keys()) if (!retried.has(id)) sealedKeyIds.delete(id);
}

/** Is this `sealed` row waiting on a key that core's negative cache holds? */
function isWaitingOnCachedKey(
	a: SweepArgs,
	entry: SetAsideEntry,
	msg: RineInbound,
): boolean {
	const keyId = sealedKeyIds.get(entry.id);
	if (entry.reason !== "sealed" || keyId === undefined) return false;
	if (!msg.groupId || !msg.fromAgentId) return false;
	return isCached(a.agentId, msg.groupId, msg.fromAgentId, keyId);
}

async function retryOne(
	a: SweepArgs,
	entry: SetAsideEntry,
	synced: SyncedGroups,
): Promise<void> {
	let row: MessageRead;
	try {
		row = (await a.client.get(
			`/messages/${entry.id}`,
			undefined,
			// `true`, unconditionally: every read on this path is a peek. Through
			// core's helper rather than the header constant so the TRUTH spelling
			// lives in one place too — this is the third peek sender, which is the
			// site `message-words.ts` named as the trigger to extract it.
			withPeekHeader({ [ACTING_AGENT_HEADER]: a.agentId }, true),
		)) as MessageRead;
	} catch (err) {
		// A row that is gone has nothing to retry; every other failure is this
		// attempt failing, which is what the bound counts.
		if (isGone(err)) dropSetAside(a.configDir, a.agentId, entry.id, a.logger);
		else bump(a, entry);
		return;
	}
	const msg = normalizeRineEvent(row);
	// 🔴 A row whose sender key a scan already found missing within the cache's
	// 15 minutes is skipped whole: no sync (`recoverGroup` bypasses the cache and
	// would scan the inbox again), no probe and no `bump`, so the wait spends none
	// of the attempt bound. The row keeps its cause and stays in `rine_inbox`.
	if (isWaitingOnCachedKey(a, entry, msg)) return;

	// 🔴 Sync BEFORE the decrypt, not after it has failed again — and only for a
	// group message whose verdict a sync can heal (`groupSyncMayHeal` argues the
	// split; a DM's key material is its own). `setaside-sync.ts` validates the
	// server-supplied id, bounds this to once per group per sweep, and never
	// throws — so the probe runs either way and the `bump` below counts a decrypt
	// that really ran, which is what `SETASIDE_MAX_ATTEMPTS` was sized to bound.
	if (msg.groupId && groupSyncMayHeal(entry.reason)) {
		await syncGroupForRetry(a, msg.groupId, synced);
	}
	// 🔴 The verdict is KEPT, not just tested. `recordSetAside` asks
	// `isPermanent` on a first sighting, and this site used to throw the answer
	// away — so a verdict that turned permanent BETWEEN sightings (`sealed` while
	// the sender key was merely missing, `mls-evicted` once the Remove landed) was
	// retried its full five times, and the give-up line then blamed the stale
	// reason. One decision, one place that makes it, either end of the entry's life.
	const verdict = await probeReadability(readabilityArgsFor(msg, a));
	if (verdict.kind === "sealed") sealedKeyIds.set(entry.id, verdict.senderKeyId);
	else sealedKeyIds.delete(entry.id);
	if (!isDispatchable(verdict)) {
		bump(a, entry, { verdict });
		return;
	}
	// 🔴 Forget the entry BEFORE dispatching. A crash in the other order re-runs
	// an agent turn on the next sweep — the dedupe Set that would have stopped it
	// is in memory and goes with the process. In this order a crash loses the
	// dispatch instead. Losing a turn is recoverable; running one twice is not.
	//
	// 🔴 How recoverable depends on the transport, and only the `poll` one gets it
	// for free: the row was never marked delivered, so a `status=new` re-fetch
	// offers it again. On `sse` — the default — it does NOT come back on its own.
	// `setAside` returned `true` so the stream cursor advanced past this id, and
	// `transports/sse.ts` resumes from the cursor against a `created_at`-ordered
	// catch-up that never reconsults delivery state. A crash inside this one
	// window therefore leaves the message reachable only through `rine_inbox` /
	// `rine_read`. That is the accepted cost of never doubling a turn; the
	// `deliver`-returned-`false` case below, which is the common one, is closed.
	dropSetAside(a.configDir, a.agentId, entry.id, a.logger);
	a.logger.info(
		`rine: set-aside message ${entry.id} opened on retry ${entry.attempts + 1} (was ${entry.reason}) → dispatching`,
	);
	// 🔴 `deliver` reports a FAILED agent turn as `false` rather than throwing,
	// and the entry is already gone by then. Without this the message would be
	// dropped from the store on the one attempt that reached the harness and
	// failed there — the exact outcome the store exists to prevent, and the one
	// the comment above claims is recoverable. The re-park keeps the attempt count
	// (`countAttempt` upserts) so a harness that fails every dispatch still
	// exhausts instead of looping.
	if (!(await a.deliver(msg))) bump(a, entry, { why: "dispatch failed" });
}

/**
 * Count one spent retry against an entry, put it back, and say so once when it
 * is the last one.
 *
 * 🔴 An UPSERT, which is what makes the re-park above possible: `retryOne`
 * forgets an entry BEFORE it dispatches, so the entry a failed delivery has to
 * put back is one the store no longer holds. Restored from the caller's copy, it
 * keeps its `firstSeen` and the attempts it had already spent — re-recording it
 * from scratch would reset the count to zero and hand a harness that fails every
 * dispatch an unbounded loop.
 *
 * The freshest attempt count wins when the entry IS still on disk, and
 * `exhausted` is sticky, so neither a stale copy nor a later caller can re-arm a
 * give-up.
 */
function bump(a: SweepArgs, entry: SetAsideEntry, ctx: BumpContext = {}): void {
	const entries = loadSetAside(a.configDir, a.agentId, a.logger);
	const found = entries.find((e) => e.id === entry.id);
	const attempts = (found?.attempts ?? entry.attempts) + 1;
	// A fresh verdict replaces the stored reason, exactly as `recordSetAside`
	// writes `verdict.kind` on a re-sighting: it is the current cause, it is what
	// the give-up line reports, and `groupSyncMayHeal` reads it next sweep to
	// decide whether a sync is even worth running.
	const permanent = ctx.verdict !== undefined && isPermanent(ctx.verdict);
	const next: SetAsideEntry = {
		...(found ?? entry),
		reason: ctx.verdict?.kind ?? found?.reason ?? entry.reason,
		attempts,
		lastTried: Date.now(),
		exhausted:
			(found?.exhausted ?? entry.exhausted) ||
			permanent ||
			attempts >= SETASIDE_MAX_ATTEMPTS,
	};
	saveSetAside(
		a.configDir,
		a.agentId,
		found ? entries.map((e) => (e.id === entry.id ? next : e)) : [...entries, next],
		a.logger,
	);
	if (!next.exhausted) return;
	const cause = ctx.why === undefined ? next.reason : `${next.reason}, ${ctx.why}`;
	// 🔴 Two different sentences, because they are two different facts. "Still
	// unreadable after 5 attempts" earned its number; a permanent verdict did not
	// and must not claim it — an operator reading five attempts against a verdict
	// reached on the first goes looking for a retry loop that never ran.
	const what = permanent
		? `cannot be read (${cause}) — retrying it would return the same verdict, so it is not retried again`
		: `is still unreadable after ${next.attempts} attempts (${cause}) — no longer retried automatically`;
	a.logger.warn(
		`rine: message ${entry.id} ${what}. It was never marked delivered, so it is still in this agent's rine inbox (rine_inbox / rine_read).`,
	);
}

/**
 * Why this bump happened, when the caller knows something the store does not.
 *
 * An object rather than two positional optionals: the call sites pass neither,
 * one, or the other, and `bump(a, entry, undefined, verdict)` is how a wrong
 * argument order becomes a silently stale reason.
 */
interface BumpContext {
	/** The verdict the re-probe just returned, when there was one. */
	verdict?: SetAsideReason;
	/** A failure the probe cannot see — today, a dispatch the harness refused. */
	why?: string;
}

/**
 * Is this failure the row being gone?
 *
 * Read off the `status` FIELD rather than with `instanceof RineApiError`, for the
 * reason core's own `asSenderKeyUnavailable` gives: two copies of `rine-core` in
 * one dependency tree make `instanceof` answer false, and `npm install
 * --install-links` COPIES `file:` deps, which is how this package's rigs get
 * exactly that. A misread 404 only costs an entry its retries, but it costs them
 * silently.
 */
function isGone(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	return (err as { status?: unknown }).status === 404;
}
