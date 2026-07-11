import { normalizeRineEvent } from "../inbound.js";
import { sleep } from "./backoff.js";
import type { TransportContext } from "./context.js";

/**
 * POLL transport — least token-intensive. Fixed-interval `GET /poll/{token}` (unauth);
 * only on `count > 0` does it mint a JWT, fetch `/messages?status=new`, and dispatch.
 *
 * Graceful fallback: the loop never crashes. A revoked/expired token (`401`/`403`) is
 * surfaced as an actionable error exactly once (REQ-FSH-06 — not masked as an empty inbox);
 * a transient network/HTTP error warns once; a healthy count of 0 is silent no-work. Every
 * failure keeps the loop alive at the fixed interval, and a healthy poll re-arms the warnings.
 */
export async function runPollTransport(tc: TransportContext): Promise<void> {
	const { client, config, agentId, logger, onMessage, signal, pollUrl } = tc;
	if (!pollUrl) {
		logger.error(
			"rine: POLL transport requires a poll_url in credentials.json (.default.poll_url) — run `rine poll-token`",
		);
		return;
	}

	// Log a persistent auth/network failure once per streak (not every interval); a healthy
	// count clears it so a later recurrence is re-reported.
	let warnedKind: "auth" | "network" | undefined;

	while (!signal.aborted) {
		const result = await client.pollCount(pollUrl, signal);
		if (result.kind === "auth-error") {
			if (warnedKind !== "auth") {
				warnedKind = "auth";
				logger.error(
					`rine: POLL token rejected (HTTP ${result.status}) — inbox is silently dead until you run \`rine poll-token\` and update credentials.json (.default.poll_url)`,
				);
			}
			await wait(config.pollIntervalMs, signal);
			continue;
		}
		if (result.kind === "error") {
			if (warnedKind !== "network") {
				warnedKind = "network";
				logger.warn("rine: POLL count request failed (network/transient) — keeping loop alive");
			}
			await wait(config.pollIntervalMs, signal);
			continue;
		}
		warnedKind = undefined; // healthy poll — re-arm the failure warnings.
		if (result.count <= 0) {
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
