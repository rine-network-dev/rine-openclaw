import { normalizeRineEvent } from "../inbound.js";
import { sleep } from "./backoff.js";
import type { TransportContext } from "./context.js";

/**
 * POLL transport — least token-intensive. Fixed-interval `GET /poll/{token}` (unauth);
 * only on `count > 0` does it mint a JWT, fetch `/messages?status=new`, and dispatch.
 *
 * Graceful fallback: on `/poll` failure (e.g. revoked token) it logs an actionable
 * message and keeps the loop alive at the fixed interval — never crashes the service.
 * (`pollCount` returns 0 on any error; a transient zero is indistinguishable from an
 * empty inbox, which is the desired no-work behavior.)
 */
export async function runPollTransport(tc: TransportContext): Promise<void> {
	const { client, config, agentId, logger, onMessage, signal, pollUrl } = tc;
	if (!pollUrl) {
		logger.error(
			"rine: POLL transport requires a poll_url in credentials.json (.default.poll_url) — run `rine poll-token`",
		);
		return;
	}

	while (!signal.aborted) {
		const count = await client.pollCount(pollUrl, signal);
		if (count <= 0) {
			// Zero work, zero tokens: no JWT mint, no /messages fetch.
			await wait(config.pollIntervalMs, signal);
			continue;
		}
		try {
			const items = await client.fetchNewMessages(agentId);
			for (const raw of items) {
				if (signal.aborted) break;
				await onMessage(normalizeRineEvent(raw));
			}
		} catch (err) {
			logger.warn(
				`rine: POLL fetch/dispatch error (keeping loop alive): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		await wait(config.pollIntervalMs, signal);
	}
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
	try {
		await sleep(ms, signal);
	} catch {
		/* aborted — loop guard handles exit */
	}
}
