import { HttpClient, getOrRefreshToken } from "@rine-network/core";
import type { MessageRead, PaginatedResponse } from "@rine-network/core";
import type { ToolContext } from "@rine-network/mcp/tools";
import { DEFAULT_ACCOUNT_ID } from "./constants.js";
import type { ResolvedCreds } from "./config.js";

/** Hard ceiling on a single unauthenticated /poll request (the poll loop owns the cadence). */
const POLL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Outcome of a `/poll` count probe. A revoked/expired poll token (`401`/`403`) is
 * distinguished from a healthy count and from a transient network/HTTP error so the poll
 * loop can surface an actionable auth warning instead of masking it as an empty inbox
 * (REQ-FSH-06).
 */
export type PollResult =
	| { kind: "count"; count: number }
	| { kind: "auth-error"; status: number }
	| { kind: "error" };

export interface RineClient {
	/** Shared `ToolContext` for the lifted mcp tool handlers. */
	toolContext: ToolContext;
	client: HttpClient;
	configDir: string;
	apiUrl: string;
	/** Mint/refresh the OAuth JWT via core's token cache (auto-refresh on 401). */
	getJwt: (force?: boolean) => Promise<string>;
	/**
	 * Unauthenticated poll: `GET {pollUrl}` → a {@link PollResult}. Reports `auth-error` on a
	 * `401`/`403` (revoked token) and `error` on any transient network/HTTP failure, so the
	 * caller never confuses a dead token for an empty inbox (REQ-FSH-06).
	 */
	pollCount: (pollUrl: string, signal?: AbortSignal) => Promise<PollResult>;
	/** Fetch new messages for an agent (auth). */
	fetchNewMessages: (agentId: string, limit?: number) => Promise<MessageRead[]>;
	/** Mark messages delivered (auth) — at-least-once after successful dispatch. */
	markDelivered: (agentId: string, ids: string[]) => Promise<number>;
}

/**
 * Build the rine HTTP client + ToolContext from resolved creds. Mirrors
 * rine-mcp/src/server.ts bootstrap: tokenFn = getCredentialEntry + getOrRefreshToken;
 * new HttpClient({ tokenFn, apiUrl, canRefresh }).
 */
export function buildRineClient(creds: ResolvedCreds): RineClient {
	const { configDir, apiUrl, entry } = creds;
	const getJwt = (force?: boolean): Promise<string> =>
		getOrRefreshToken(configDir, apiUrl, entry, DEFAULT_ACCOUNT_ID, { force });

	const client = new HttpClient({
		tokenFn: getJwt,
		apiUrl,
		canRefresh: Boolean(entry),
	});

	const toolContext: ToolContext = { client, configDir, apiUrl };

	async function pollCount(pollUrl: string, signal?: AbortSignal): Promise<PollResult> {
		try {
			const res = await fetch(pollUrl, {
				signal: signal ?? AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS),
			});
			// A revoked/expired poll token is a persistent auth failure, not a transient blip —
			// surface it distinctly so the loop can warn actionably (run `rine poll-token`).
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

	async function fetchNewMessages(agentId: string, limit = 50): Promise<MessageRead[]> {
		const res = (await client.get(`/agents/${agentId}/messages`, {
			status: "new",
			limit,
		})) as PaginatedResponse<MessageRead>;
		return Array.isArray(res.items) ? res.items : [];
	}

	async function markDelivered(agentId: string, ids: string[]): Promise<number> {
		if (ids.length === 0) return 0;
		const res = await client.markDelivered(agentId, ids);
		return res.marked;
	}

	return {
		toolContext,
		client,
		configDir,
		apiUrl,
		getJwt,
		pollCount,
		fetchNewMessages,
		markDelivered,
	};
}
