import type { Probe } from "@rine-network/core";

/**
 * What a set-aside message is called, and the one question asked of a readability
 * verdict.
 *
 * Split out of `setaside.ts` for the file-size budget, on the same terms as
 * `rine-core`'s own `inbound-readability-words.ts` — no I/O, no crypto, no
 * client, and nothing here can fail. The store that PERSISTS these is next door
 * and re-exports this file, so a consumer imports one module.
 */

/** The two verdicts that mean "hand this to the harness exactly as before". */
export type DispatchableVerdict =
	| { readonly kind: "opened" }
	| { readonly kind: "not-ciphertext" };

/**
 * A verdict that gets a message set aside: every readability answer that is
 * neither an open nor "this was never ciphertext this build attempts".
 *
 * Derived from core's `Probe` rather than restated, so an arm added there cannot
 * be silently dropped on the floor here — it arrives as a new `reason` value
 * instead of as a message class that quietly stops being retried.
 */
export type SetAsideReason = Exclude<Probe, DispatchableVerdict>;

/**
 * One set-aside message.
 *
 * 🔴 Ids and counters only — never ciphertext, never plaintext, and no
 * verification detail beyond `reason`. That is the discipline `rine-hermes`'
 * consumed journal states for itself and the one `transports/cursor.ts` already
 * followed. Storing the envelope would make a retry purely local at the price of
 * a durable ciphertext copy on disk; an id plus a re-read is the conservative
 * trade, and the store's bounds are sized for it.
 */
export interface SetAsideEntry {
	/** rine message id — the only identifier, and the retry read's whole input. */
	id: string;
	reason: SetAsideReason["kind"];
	attempts: number;
	/** epoch ms; the eviction order and the only age this store keeps. */
	firstSeen: number;
	lastTried: number | null;
	/** Retried no further. Still listed, and its row is still in the rine inbox. */
	exhausted: boolean;
}

/**
 * Whether a verdict means the message goes to the harness.
 *
 * A type predicate rather than a bare boolean so both callers — the dispatch
 * gate and the retry sweep — narrow off the ONE spelling of the question.
 * Written out twice, the two copies drift, and the drift is a message class that
 * silently stops being retried.
 */
export function isDispatchable(verdict: Probe): verdict is DispatchableVerdict {
	return verdict.kind === "opened" || verdict.kind === "not-ciphertext";
}

/**
 * Whether catching this message's GROUP up could open it, per arm.
 *
 * A table rather than a switch, and typed `Record<SetAsideReason["kind"], …>` on
 * purpose: every arm core defines has to carry an answer here, so a new one is a
 * missing property and a compile error instead of silently landing in "no sync".
 * The two `true`s are the arms whose own definitions next door in `rine-core`
 * name a sync as the remedy, and they are the only two:
 *
 *  - `sealed` — the sender key arrives as an ordinary distribution DM, and
 *    catching the group up installs whatever is already waiting in this agent's
 *    inbox.
 *  - `mls-recoverable` — installing Welcomes or replaying the group's commits
 *    might make a local key open this.
 *
 * 🔴 `mls-evicted` is the arm that proves the question is asked rather than
 * assumed: no sync undoes a Remove, so syncing there asks the reader for a move
 * it cannot complete. Core calls it permanent and the sweep therefore never
 * reaches it at all — this is the second lock on that door, not the first.
 *
 * `refused` is permanent and drained. `failed` is the unknown-cause arm and
 * includes the transport failures of core's own recovery fetch, so syncing on it
 * would answer a network fault with more network. `no-keys` has no group state
 * to catch up: its remedy is an operator restoring key material (`keyless.ts`),
 * and a sync would fail on the same missing keys.
 */
const GROUP_SYNC_MAY_HEAL: Record<SetAsideReason["kind"], boolean> = {
	sealed: true,
	"mls-recoverable": true,
	"mls-evicted": false,
	refused: false,
	failed: false,
	"no-keys": false,
};

/**
 * Could a group sync open this parked message?
 *
 * Asked of the PERSISTED reason, which is what lets the sync run ahead of the
 * retry's decrypt instead of after a probe has already failed. A `reason` a
 * newer build wrote and this one does not know answers `false`: the lookup
 * misses, and `=== true` refuses an `undefined` — `loadSetAside` keeps such an
 * entry rather than dropping a live retry, so the value really can arrive.
 */
export function groupSyncMayHeal(reason: SetAsideEntry["reason"]): boolean {
	return GROUP_SYNC_MAY_HEAL[reason] === true;
}
