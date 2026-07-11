import { fetchAgents, resolveAgent } from "@rine-network/core";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk";
import type {
	OpenClawPluginService,
	OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/core";
import type { ResolvedCreds } from "./config.js";
import { readRineCredentials, resolveRineConfigFromCfg } from "./config.js";
import { makeOnMessage, makeRuntimeDispatcher } from "./dispatch.js";
import { buildRineClient } from "./rine-client.js";
import type { RineClient } from "./rine-client.js";
import type { TransportContext } from "./transports/context.js";
// Statically imported: expose.ts is already in the static graph (index.ts imports
// registerExposeRoute from it), so a dynamic import here only triggers the tsdown
// INEFFECTIVE_DYNAMIC_IMPORT warning without splitting a chunk.
import { runExposeTransport } from "./transports/expose.js";
import type { RineConfig } from "./types.js";

const SERVICE_ID = "rine-notify";

/** Run the chosen transport. Exposed for testing with a stubbed transport map. */
export async function runTransport(tc: TransportContext): Promise<void> {
	switch (tc.config.transport) {
		case "poll": {
			const { runPollTransport } = await import("./transports/poll.js");
			return runPollTransport(tc);
		}
		case "expose": {
			return runExposeTransport(tc);
		}
		default: {
			const { runSseTransport } = await import("./transports/sse.js");
			return runSseTransport(tc);
		}
	}
}

/**
 * Resolve the rine agent id this install is bound to. `channels.rine.agentId` (a UUID,
 * handle, or bare name) wins; otherwise the org's sole agent is auto-selected — the same
 * resolution the CLI uses (`fetchAgents` + `resolveAgent`).
 *
 * The OAuth `client_id` is NOT an agent id: credentials.json stores `client_id`/`client_secret`,
 * and binding the transport to it requests `/agents/{client_id}/stream|messages`, which 404s on
 * every transport. Returns undefined (the service idles) on a network error or an ambiguous
 * multi-agent org with no `agentId` set — both surface an actionable log; the gateway
 * health-monitor restarts the idle service, re-resolving once connectivity/config is fixed.
 */
export async function resolveBoundAgentId(
	client: RineClient,
	config: RineConfig,
	logger: PluginLogger,
): Promise<string | undefined> {
	try {
		const agents = await fetchAgents(client.client);
		return await resolveAgent(client.apiUrl, agents, config.agentId);
	} catch (err) {
		logger.error(
			`rine: cannot resolve agent to bind (${err instanceof Error ? err.message : String(err)}). ` +
				"Set channels.rine.agentId (UUID or handle) or check connectivity — notify service idle.",
		);
		return undefined;
	}
}

/** Resolve the bound agent, wire dispatch + transport context, and run the transport loop. */
async function startNotifyLoop(params: {
	api: OpenClawPluginApi;
	config: RineConfig;
	creds: ResolvedCreds;
	client: RineClient;
	signal: AbortSignal;
	logger: PluginLogger;
}): Promise<void> {
	const { api, config, creds, client, signal, logger } = params;
	const agentId = await resolveBoundAgentId(client, config, logger);
	if (!agentId || signal.aborted) return;

	const dispatch = makeRuntimeDispatcher({
		cfg: api.config,
		runtime: api.runtime,
		client,
		agentId,
		logger,
	});
	const onMessage = makeOnMessage({ client, config, agentId, logger, dispatch, signal });
	const tc: TransportContext = {
		client,
		config,
		agentId,
		logger,
		onMessage,
		signal,
		pollUrl: creds.pollUrl,
	};
	logger.info(`rine: notify service starting (transport=${config.transport}, agent=${agentId})`);
	await runTransport(tc);
}

/**
 * The single background notify service. `start(ctx)` resolves creds, owns the
 * AbortController (the service ctx has NO abort signal — see SDK_CONTRACT.md), then
 * hands off to `startNotifyLoop` which resolves the bound agent id and runs the transport.
 * `stop` aborts it. The long-lived loop lives here, not in a channel `gateway.startAccount`.
 */
export function makeRineService(api: OpenClawPluginApi): OpenClawPluginService {
	let controller: AbortController | undefined;

	return {
		id: SERVICE_ID,
		start(ctx: OpenClawPluginServiceContext): void {
			const logger = ctx.logger ?? api.logger;
			const config = resolveRineConfigFromCfg(api.config);
			const creds = readRineCredentials(config);
			if (!creds.entry) {
				logger.warn(
					`rine: no credentials.json at ${creds.configDir} — notify service idle (run rine_onboard or set RINE_CONFIG_DIR)`,
				);
				return;
			}
			const client = buildRineClient(creds);
			controller = new AbortController();
			const signal = controller.signal;
			// Resolve the bound agent id from the API (NOT the OAuth client_id) before running
			// the transport. Fire-and-forget with the service-owned signal; it owns its own
			// error handling + fallbacks.
			void startNotifyLoop({ api, config, creds, client, signal, logger }).catch((err) => {
				logger.error(
					`rine: notify transport exited: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		},
		stop(): void {
			controller?.abort();
			controller = undefined;
		},
	};
}
