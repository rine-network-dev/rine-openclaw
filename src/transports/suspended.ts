import { RineApiError, type RineErrorBody, holdOf } from "@rine-network/core";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

/** How long a held agent waits before it asks again. */
export const SUSPENDED_RETRY_MS = 30_000;

/** The two log lines of a suspension: one on entering it, one on leaving it. */
export const SUSPENDED_LINE = "rine: agent is suspended; retrying every 30 s until it is resumed";
export const RESUMED_LINE = "rine: agent resumed; stream reconnected";

/**
 * The JSON body of a failed response, or `undefined` when there is none. A transport's own
 * `fetch` meets the server's hold refusal here; `HttpClient` callers get it on `RineApiError`.
 */
export async function errorBodyOf(res: Response): Promise<RineErrorBody | undefined> {
	try {
		return (await res.json()) as RineErrorBody;
	} catch {
		return undefined;
	}
}

/** Does this failure name a hold (a suspended agent or branch, a frozen org)? */
export function isHold(err: unknown): boolean {
	return err instanceof RineApiError && holdOf(err.status, err.body) !== undefined;
}

/**
 * The error a refused stream request becomes. A 403 carries the hold's code in its body, so it
 * is read there; any other status stays a bare status error.
 */
export async function streamRefusal(res: Response): Promise<RineApiError> {
	const body = res.status === 403 ? await errorBodyOf(res) : undefined;
	return new RineApiError(res.status, `stream HTTP ${res.status}`, res, undefined, body);
}

/**
 * Logs a suspension once when it starts and its end once when the transport is back, however
 * many retries lie between. One per transport run.
 */
export function suspensionLog(logger: PluginLogger): { held: () => void; recovered: () => void } {
	let announced = false;
	return {
		held: () => {
			if (announced) return;
			announced = true;
			logger.warn(SUSPENDED_LINE);
		},
		recovered: () => {
			if (!announced) return;
			announced = false;
			logger.info(RESUMED_LINE);
		},
	};
}
