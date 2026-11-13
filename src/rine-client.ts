import {
	HttpClient,
	getOrRefreshToken,
	inBackground,
	jitteredRefreshMargin,
	pinOwnIdentity,
	resolveAuth,
	startupEscrowSweep,
} from "@rine-network/core";
import type {
	AgentOnlyDirs,
	AuthDirs,
	MessageRead,
	PaginatedResponse,
	ResolvedAuth,
} from "@rine-network/core";
import type { ToolContext } from "@rine-network/mcp/tools";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { ResolvedIdentity } from "./config.js";
import { type PollResult, pollCount } from "./poll-count.js";
import type { RineConfig } from "./types.js";

export interface RineClient {
	/** Shared `ToolContext` for the lifted mcp tool handlers. It signs in as the agent and never loads `root.key`. */
	toolContext: ToolContext;
	/**
	 * The context of `rine_onboard` alone. Registering an org and creating its first agent
	 * is an owner act, so this client resolves the owner dir the way the CLI does; when the
	 * tool finishes, the agent identity it wrote comes live on `toolContext` as well.
	 */
	onboardContext: ToolContext;
	client: HttpClient;
	configDir: string;
	apiUrl: string;
	/** Mint/refresh the access token via core's token cache (auto-refresh on 401). */
	getJwt: (force?: boolean) => Promise<string>;
	/**
	 * Unauthenticated poll: `GET {pollUrl}` → a {@link PollResult}. Reports `auth-error` on a
	 * `401`/`403` (revoked token) and `error` on any transient network/HTTP failure, so the
	 * caller never confuses a dead token for an empty inbox.
	 */
	pollCount: (pollUrl: string, signal?: AbortSignal) => Promise<PollResult>;
	/** Fetch new messages for an agent (auth). */
	fetchNewMessages: (agentId: string, limit?: number) => Promise<MessageRead[]>;
	/** Mark messages delivered (auth) — at-least-once after successful dispatch. */
	markDelivered: (agentId: string, ids: string[]) => Promise<number>;
	/**
	 * Clear the escrow files a previous process left behind, for the agents this principal can
	 * act as. Never throws; core's own gate keeps a second call inside the heartbeat interval
	 * from repeating the pass, so the notify service calls it once per start.
	 */
	sweepEscrowAtStart: () => void;
}

/**
 * An HTTP client that signs a `private_key_jwt` assertion with the principal `dirs`
 * resolves to, and the key-chain pins seeded with this install's own org and agent ids,
 * so a peer-key response that places one of our agents under another org is refused
 * instead of trusted on first use.
 *
 * Only a FOUND identity is kept. A client built before the install had one looks again on
 * the next mint, so a `rine_onboard` run in this process (which also calls
 * `refreshIdentity`) or an onboarding in another one comes live without a restart; without
 * it the disk-cached onboarding token is the only thing the client ever has, and every call
 * fails once that token reaches its refresh margin.
 */
function authedClient(
	dirs: AuthDirs,
	apiUrl: string,
	initial: ResolvedAuth | undefined,
	refreshMargin: number,
) {
	let auth = initial;
	const currentAuth = () => (auth ??= resolveAuth(dirs));
	const getJwt = (force?: boolean): Promise<string> => {
		const current = currentAuth();
		return getOrRefreshToken(current?.cacheDir ?? dirs.configDir, apiUrl, current?.signer, {
			force,
			refreshMargin,
		});
	};
	const client = new HttpClient({ tokenFn: getJwt, apiUrl, canRefresh: true });
	pinOwnIdentity(client, dirs.configDir, currentAuth);
	const refreshIdentity = (): void => {
		auth = undefined;
		pinOwnIdentity(client, dirs.configDir, currentAuth);
	};
	return { client, currentAuth, getJwt, refreshIdentity };
}

/** The operator seat and warning sink a tool context is built with, from the resolved config. */
export function operatorSetting(
	config: RineConfig,
	logger: PluginLogger,
): NonNullable<ToolContext["operator"]> {
	return { pin: config.operator, warn: (message) => logger.warn(`rine: ${message}`) };
}

/**
 * Build the rine HTTP client + ToolContext from resolved creds. Mirrors
 * rine-mcp/src/context.ts, except that the runtime signs in as the agent only: an owner
 * dir on the host never makes a tool call act as the org.
 *
 * `operator` is the seat the tool rows may classify as the operator, with the sink for its
 * warnings; without it every row a tool returns is framed as data from another party.
 */
export function buildRineClient(
	creds: ResolvedIdentity,
	operator?: ToolContext["operator"],
): RineClient {
	const { configDir, ownerDir, apiUrl } = creds;
	const runtimeDirs: AgentOnlyDirs = { configDir, agentOnly: true };
	// Drawn once per client instance so co-located agents desynchronize their token
	// refreshes instead of clustering into the same minute.
	const refreshMargin = jitteredRefreshMargin();
	const runtime = authedClient(runtimeDirs, apiUrl, creds.auth, refreshMargin);
	const { client, currentAuth, getJwt } = runtime;

	const toolContext: ToolContext = {
		client,
		configDir,
		ownerDir,
		apiUrl,
		refreshIdentity: runtime.refreshIdentity,
		operator,
	};

	// Built on first use: resolving the owner dir loads `root.key`, which a runtime that
	// never onboards must not do at start-up.
	let owner: ReturnType<typeof authedClient> | undefined;
	const onboardContext: ToolContext = {
		get client() {
			owner ??= authedClient({ configDir, ownerDir }, apiUrl, undefined, refreshMargin);
			return owner.client;
		},
		configDir,
		ownerDir,
		apiUrl,
		refreshIdentity() {
			owner?.refreshIdentity();
			runtime.refreshIdentity();
		},
	};

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

	function sweepEscrowAtStart(): void {
		inBackground(() => startupEscrowSweep(client, configDir, currentAuth()?.agentId));
	}

	return {
		toolContext,
		onboardContext,
		client,
		configDir,
		apiUrl,
		getJwt,
		pollCount,
		fetchNewMessages,
		markDelivered,
		sweepEscrowAtStart,
	};
}
