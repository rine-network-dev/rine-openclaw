/**
 * The single `"default"` profile/account literal, shared so a rename touches one place.
 *
 * It is the rine credential *profile* key passed to core's
 * `getCredentialEntry`/`getOrRefreshToken` (the entry under `.default` in
 * credentials.json) and, identically, the OpenClaw single-account id for the rine
 * channel. Both are `"default"` by convention.
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * The rine channel / plugin id. It is the key under both `channels.<id>` (activation +
 * effective config) and `plugins.entries.<id>` in openclaw.json, and the `id` this plugin
 * registers under. Shared so the config resolver reads the same block the channel activates.
 */
export const CHANNEL_ID = "rine";

/**
 * Internal mcp tools the plugin depends on at runtime but does NOT expose to the agent.
 * Validated at startup (alongside `selectExposedTools`) so a rename of an mcp tool fails
 * fast at load, not at first reply. `rine_reply` backs the inbound→reply dispatch path;
 * `rine_send` backs the channel `outbound` adapter (active sends to an arbitrary target).
 */
export const INTERNAL_TOOLS = ["rine_reply", "rine_send"] as const;

/**
 * How many set-aside messages one agent's sidecar holds.
 *
 * 500, the same number as `hermes_rine._setaside`'s `SETASIDE_MAX_ROWS`, on the
 * same terms {@link SETASIDE_SWEEP_BATCH} already reasons from: the two
 * connectors run one policy against one server, so a capacity that differed
 * would be a difference nobody chose. Attempts, sweep batch and sweep interval
 * were identical from the start; this was the one bound that was not, and the
 * only one carrying no reason of its own.
 *
 * 🔴 Overflow drops an ENTRY, never a message. The row itself stays `new` on the
 * server — the runtime never marked it delivered — so a dropped entry loses only
 * its automatic retry and the message is still there for `rine_inbox` /
 * `rine_read`. Oldest `exhausted` entry goes first: it will never be retried, so
 * its only remaining value is being listable.
 *
 * Reachable only above 500 unreadable messages in ONE config dir, which is why
 * the cost of the higher number is a longer JSON sidecar and nothing else: the
 * store is a whole-file read-modify-write, and {@link SETASIDE_SWEEP_BATCH} —
 * not this — is what bounds the I/O one sweep spends.
 */
export const SETASIDE_MAX_ENTRIES = 500;

/**
 * Retries before a set-aside message stops being retried automatically.
 *
 * The bound is the whole reason a retry is safe to ship: a permanently
 * unreadable message must not re-quarantine the inbox on every tick forever,
 * which is the log/IO storm the drain-on-first-sight policy was written to
 * prevent. Exhaustion does NOT ack the row.
 */
export const SETASIDE_MAX_ATTEMPTS = 5;

/**
 * Minimum wall-clock between two set-aside sweeps, and the timer's period.
 *
 * Two things ask for a sweep — the interval timer
 * (`setaside-schedule.ts`, which is what keeps a quiet channel retrying) and the
 * tail of each delivered inbound, because the thing that heals a `sealed` entry
 * is a `rine.v1.sender_key_distribution` DM that has just gone past. This bound
 * is what stops the second one from re-reading the list on every frame of a busy
 * stream, and what stops the two from ever running back to back.
 */
export const SETASIDE_SWEEP_INTERVAL_MS = 300_000;

/**
 * How many set-aside entries one sweep may retry.
 *
 * 50, the same number and the same name as `hermes_rine._setaside`'s
 * `SETASIDE_SWEEP_BATCH`, which its store applies as `due(limit=...)`: the two
 * connectors run one policy against one server, and a difference here would be a
 * difference nobody chose. Each retry is a `GET /messages/{id}` plus a decrypt
 * attempt, and a parked group entry additionally spends one group sync per group
 * per sweep (`setaside-sync.ts`), so an unbounded sweep over a full
 * {@link SETASIDE_MAX_ENTRIES} list is 500 of both, on the tick of a timer,
 * while the harness waits.
 *
 * 🔴 Nothing is DROPPED by the bound — entries the batch does not reach keep
 * their place and their attempt counts — but nothing is promised the tail either:
 * the order is oldest-first on every sweep (hermes' `ORDER BY first_seen ASC
 * LIMIT ?`), not least-recently-tried, so a list longer than one batch serves its
 * head again and the tail waits for that head to clear by healing or exhausting.
 * Bounded by {@link SETASIDE_MAX_ATTEMPTS} sweeps, and only reachable at all with
 * more than 50 unreadable messages in one config dir.
 */
export const SETASIDE_SWEEP_BATCH = 50;
