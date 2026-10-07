/**
 * How recent a catch-up frame must be to count as live. Catch-up carries undelivered rows only,
 * so a frame this young is a real, unanswered message; anything older is a stale backlog that
 * keeps the no-auto-reply `replayed` treatment.
 */
export const FRESH_CATCHUP_WINDOW_MS = 10 * 60_000;

/** True when `createdAt` (ISO-8601) is within {@link FRESH_CATCHUP_WINDOW_MS} of `now`. An unparseable stamp is stale. */
export function isFreshCatchup(createdAt: string | undefined, now: number = Date.now()): boolean {
	const created = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
	return now - created <= FRESH_CATCHUP_WINDOW_MS;
}
