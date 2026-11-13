import { type HoldCode, holdOf } from "@rine-network/core";
import { errorBodyOf } from "./transports/suspended.js";

/** The unauthenticated `/poll` count probe, split out of `rine-client.ts` for the file-size budget. */

/** Hard ceiling on a single unauthenticated /poll request (the poll loop owns the cadence). */
const POLL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Outcome of a `/poll` count probe. A revoked/expired poll token (`401`/`403`) is
 * distinguished from a healthy count and from a transient network/HTTP error so the poll
 * loop can surface an actionable auth warning instead of masking it as an empty inbox. A
 * `403` that names a hold is neither: the token is good and the agent (or its branch, or its
 * org) is held, so the loop waits for the resume instead of declaring the token dead.
 */
export type PollResult =
	| { kind: "count"; count: number }
	| { kind: "held"; hold: HoldCode }
	| { kind: "auth-error"; status: number }
	| { kind: "error" };

/** `GET {pollUrl}` → a {@link PollResult}; never throws. */
export async function pollCount(pollUrl: string, signal?: AbortSignal): Promise<PollResult> {
	try {
		const res = await fetch(pollUrl, {
			signal: signal ?? AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS),
		});
		// A revoked/expired poll token is a persistent auth failure, not a transient blip —
		// surface it distinctly so the loop can warn actionably (run `rine poll-token`).
		if (res.status === 403) {
			const hold = holdOf(403, await errorBodyOf(res));
			if (hold !== undefined) return { kind: "held", hold };
		}
		if (res.status === 401 || res.status === 403) {
			return { kind: "auth-error", status: res.status };
		}
		if (!res.ok) return { kind: "error" };
		const body = (await res.json()) as { count?: unknown };
		return { kind: "count", count: typeof body.count === "number" ? body.count : 0 };
	} catch {
		return { kind: "error" };
	}
}

