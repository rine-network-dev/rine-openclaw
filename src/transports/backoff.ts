/** Sleep for `ms`, resolving early (rejecting) if the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * OpenClawcity exp-backoff + jitter:
 *   exp = base * 2^attempt; capped = min(exp, max);
 *   jitter = capped * 0.3 * (rand*2 - 1); return max(100, capped + jitter)
 * Bounded to >=100ms and <= max + 30% jitter.
 */
export function backoff(
	attempt: number,
	baseMs: number,
	maxMs: number,
	rand: () => number = Math.random,
): number {
	const exp = baseMs * 2 ** attempt;
	const capped = Math.min(exp, maxMs);
	const jitter = capped * 0.3 * (rand() * 2 - 1);
	return Math.max(100, capped + jitter);
}
