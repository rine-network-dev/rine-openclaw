import {
	ACTING_AGENT_HEADER,
	UUID_RE,
	readableGroupById,
	recoverGroup,
} from "@rine-network/core";
import type { HttpClient } from "@rine-network/core";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { msgOf } from "./err.js";

/**
 * Catch a parked message's GROUP up, before its decrypt is retried.
 *
 * The gap it closes: a group message sealed under a sender key this agent does
 * not hold — or an MLS message whose commits it has not replayed — was retried
 * five times over twenty-five minutes, and nothing on that path ever asked the
 * server about the group. Each retry re-read the same row and tried the same
 * local key material against the same bytes, so every attempt after the first
 * was a rehearsal of the first. The agent holds a sync verb of its own, but a
 * parked message wakes no turn, so an unattended host had nobody to run it.
 *
 * 🔴 It REUSES core's `recoverGroup` — the same function behind the agent-facing
 * sync tool (`rine-mcp/src/tools/group-sync.ts`), reached the same way. Two
 * consequences worth naming. The automatic path and the asked-for one cannot
 * drift into two recoveries. And the invariants that function already holds are
 * held here by construction rather than by a comment:
 *
 *  - **Key-package replenishment fires on every MLS operation**, not only where
 *    a Welcome was processed. `recoverGroup` tops up AHEAD of its regime branch,
 *    so the top-up rides both the result and the resync refusal — which matters
 *    most here, because an agent whose published key packages ran out is exactly
 *    the agent whose state will not load.
 *  - **Welcomes are installed scoped or not at all.** `recoverGroup` installs
 *    only a Welcome for the group it recovers, and only when this agent holds
 *    no state for it, before it tries to take the agent's own seat back.
 *
 * 🔴 The group id came from the SERVER, in a row the sweep re-read a moment ago,
 * so it is untrusted input, and it is spent in three places that each have their
 * own answer to that. The REQUEST path is guarded by `UUID_RE` before anything
 * is interpolated, so a `group_id` of `../agents/…` cannot become a URL —
 * strictly, and safely so, because the producer is the server's own UUID
 * serialiser and not a human typing a reference. The ROW is resolved by core's
 * `readableGroupById`, which reads 404/403 as a MISS and throws on a body naming
 * a different group, so `recoverGroup` is handed the row and never a bare id.
 * And no FILESYSTEM path is built from it at all: core keys MLS state by the
 * hashed group id under a store root of its own, so no spelling of it ever
 * becomes a filename.
 */

/** The client, identity and log one sync needs. `SweepArgs` extends this. */
export interface GroupSyncContext {
	client: HttpClient;
	configDir: string;
	agentId: string;
	logger: PluginLogger;
}

/**
 * The groups one sweep has already asked about.
 *
 * Owned by `sweepSetAside` and threaded down, so the bound is one sync per group
 * per SWEEP and not one per entry: many entries parked on one group is the
 * ordinary shape of this list — one absent sender key seals every message sent
 * under it — and a recovery per entry would ask one question fifty times. A
 * `Set` and not a timestamp, because the sweep is already the clock.
 */
export type SyncedGroups = Set<string>;

/**
 * Ask the server to catch this group up, at most once per sweep, and never
 * throw.
 *
 * 🔴 Never throwing is the contract the sweep is written to. The decrypt runs
 * whether this succeeded, failed or was skipped, so a failed sync cannot consume
 * an attempt that a decrypt never got — the bound counts retries of the read,
 * which is what it was sized for, and a server that is down for five minutes
 * does not exhaust a message's five chances without ever having tried one.
 *
 * Nor is a failure retried inside the sweep: the id joins {@link SyncedGroups}
 * BEFORE the await, so a group whose sync is failing costs one round trip per
 * sweep rather than one per parked entry.
 *
 * WARN and not DEBUG on failure: it is bounded to once per group per sweep, and
 * the two things it reports — a server that will not serve this group, and MLS
 * state that will not load at all — are both an operator's business. A group
 * still inside its own MLS init arrives here as core's refusal that there is no
 * epoch chain to catch up with yet; that one clears itself, and is bounded the
 * same way.
 */
export async function syncGroupForRetry(
	a: GroupSyncContext,
	groupId: string,
	synced: SyncedGroups,
): Promise<void> {
	if (synced.has(groupId) || !UUID_RE.test(groupId)) return;
	synced.add(groupId);
	const headers = { [ACTING_AGENT_HEADER]: a.agentId };
	try {
		const group = await readableGroupById(a.client, groupId, headers);
		if (group === undefined) {
			// The MISS and not a refusal: the group is gone, or this agent's org is
			// no longer in it. Either way there is nothing to catch up, and nothing
			// changes for the message — it stays parked, and the attempt bound is
			// what eventually gives up on it.
			a.logger.debug?.(
				`rine: group ${groupId} is not readable by this agent — nothing to sync before its retry`,
			);
			return;
		}
		const result = await recoverGroup(
			a.configDir,
			a.agentId,
			group,
			a.client,
			headers,
		);
		a.logger.debug?.(
			`rine: synced group ${group.handle ?? group.id} (${result.regime}) before retrying its set-aside message(s)`,
		);
	} catch (err) {
		a.logger.warn(
			`rine: could not sync group ${groupId} before retrying its set-aside message(s): ${msgOf(err)}`,
		);
	}
}
