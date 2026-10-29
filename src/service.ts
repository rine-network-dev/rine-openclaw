import { ACTOR_SURFACES, type ActorSurface, resolveActor } from "@rine-network/core";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
	OpenClawPluginService,
	OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/core";
import type { ResolvedIdentity } from "./config.js";
import { readRineIdentity, resolveRineConfigFromCfg } from "./config.js";
import { makeOnMessage } from "./dispatch.js";
import { makeRuntimeDispatcher } from "./runtime-dispatch.js";
import { buildRineClient } from "./rine-client.js";
import type { RineClient } from "./rine-client.js";
import type { TransportContext } from "./transports/context.js";
// Statically imported: expose.ts is already in the static graph (index.ts imports
// registerExposeRoute from it), so a dynamic import here only triggers the tsdown
// INEFFECTIVE_DYNAMIC_IMPORT warning without splitting a chunk.
import { runExposeTransport } from "./transports/expose.js";
import { sleep } from "./transports/backoff.js";
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
 * Resolve the UUID of the agent whose inbox the notify service reads. This is the
 * *transport* half of `channels.rine.agentId` — the tool half never comes here, because
 * `withActingAgent` hands rine-mcp the operator's string unresolved and it resolves once
 * per call. The plugin signs in as the agent its config dir holds, so that agent is the only
 * one it can act as: `channels.rine.agentId` (a UUID, handle, or bare name) and `RINE_AGENT`
 * only name it, they never choose among an org's agents. `resolveActor` takes the configured
 * value first, then `RINE_AGENT`, then the config dir's own agent. Configuration beating the
 * environment is precedence and stays silent.
 *
 * The token's subject is NOT an agent id: a token subject is an `org:`-prefixed principal
 * string, and binding the transport to it would request `/agents/{subject}/stream|messages`,
 * which 404s on every transport. Returns undefined (the service idles) on a network error or
 * a name that resolves to no agent — both surface an actionable log, and nothing
 * retries. Plugin services start from `startPluginServices`, at gateway startup and on a
 * config reload; the channel health-monitor calls `stopChannel`/`startChannel`, and rine
 * declares no `gateway.startAccount` for either to act on, so it never reaches a service.
 * The service idles until the gateway restarts or reloads its config. Missing credentials
 * are the one case that recovers on its own: `waitForIdentity` re-reads the config dir
 * on the poll cadence, so an install that onboards mid-session comes live without one.
 */
/**
 * How the TRANSPORT half spells the acting agent in a sentence it prints.
 *
 * `ACTOR_SURFACES.mcp` with the spelling replaced, on the precedent the core's own
 * `ACTOR_SURFACES` sets (`send --from` is `cli` with `alias` overridden — spread it,
 * do not mint a fourth entry): there is no `agent` parameter anywhere on this path.
 * The value came out of `openclaw.json`, so a warning telling the operator to "omit
 * agent" names a lever this surface does not have, and the one it does have —
 * `channels.rine.agentId` — is the one the catch branch below already names. No
 * `alias`: this surface never had a retired spelling, and it passes one value.
 */
const TRANSPORT_SURFACE: ActorSurface = {
	...ACTOR_SURFACES.mcp,
	alias: undefined,
	canonical: "channels.rine.agentId",
	flagHint: "channels.rine.agentId",
};

export async function resolveBoundAgentId(
	client: RineClient,
	config: RineConfig,
	logger: PluginLogger,
): Promise<string | undefined> {
	try {
		const resolved = await resolveActor(
			client.client,
			config.agentId,
			undefined,
			TRANSPORT_SURFACE,
		);
		// A one-agent org acts on a `channels.rine.agentId` that names
		// nobody rather than leaving the notify service idle. The operator wrote
		// that value, so the operator is who hears about it — `logger.warn`, the
		// transport half's own channel, not a tool result the model would read as
		// a lever it can pull.
		if (resolved.warning !== undefined) logger.warn(`rine: ${resolved.warning}`);
		return resolved.agentId;
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
	creds: ResolvedIdentity;
	client: RineClient;
	signal: AbortSignal;
	logger: PluginLogger;
}): Promise<void> {
	const { api, config, creds, client, signal, logger } = params;
	const agentId = await resolveBoundAgentId(client, config, logger);
	if (!agentId || signal.aborted) return;
	client.sweepEscrowAtStart();

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
 * Whether `creds` carry everything the chosen transport needs. Onboarding writes
 * the agent key and profiles.json in two steps — the identity first, `poll_url` seconds later
 * once the agent exists — so a POLL install waits for the second write. Picking credentials up in
 * between would freeze `pollUrl: undefined` into the transport context, and the poll loop
 * exits for good on a missing poll_url; it is also the bottom rung of the SSE fallback.
 */
function isTransportReady(creds: ResolvedIdentity, config: RineConfig): boolean {
	if (!creds.auth) return false;
	return config.transport !== "poll" || Boolean(creds.pollUrl);
}

/**
 * Wait for rine credentials to appear, re-reading the config dir on the poll cadence.
 * A fresh install registers itself through `rine_onboard` mid-session; picking the new
 * credentials up here brings the inbox live without a gateway restart. Resolves undefined
 * when `stop()` aborts the wait.
 */
async function waitForIdentity(
	config: RineConfig,
	signal: AbortSignal,
): Promise<ResolvedIdentity | undefined> {
	while (!signal.aborted) {
		try {
			await sleep(config.pollIntervalMs, signal);
		} catch {
			return undefined;
		}
		const creds = readRineIdentity(config);
		if (isTransportReady(creds, config)) return creds;
	}
	return undefined;
}

/** Resolve credentials (waiting for them if the install has not onboarded), then run the loop. */
async function startWhenIdentified(params: {
	api: OpenClawPluginApi;
	config: RineConfig;
	signal: AbortSignal;
	logger: PluginLogger;
}): Promise<void> {
	const { api, config, signal, logger } = params;
	let creds = readRineIdentity(config);
	if (!creds.auth) {
		// Logged once, not per attempt — an uncredentialed gateway must not flood its log.
		logger.warn(
			`rine: no agent identity at ${creds.configDir} — notify service idle until one appears (run rine_onboard or set RINE_CONFIG_DIR)`,
		);
		const found = await waitForIdentity(config, signal);
		if (!found) return;
		creds = found;
		logger.info(`rine: identity found at ${creds.configDir} — starting notify service`);
	}
	await startNotifyLoop({ api, config, creds, client: buildRineClient(creds), signal, logger });
}

/**
 * The single background notify service. `start(ctx)` resolves creds, owns the
 * AbortController — OpenClaw hands a service context that carries no abort signal, so
 * cancellation is ours to construct and ours to fire — then
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
			controller = new AbortController();
			const signal = controller.signal;
			// Resolve the bound agent id from the API (NOT the token subject) before running
			// the transport. Fire-and-forget with the service-owned signal; it owns its own
			// error handling + fallbacks.
			void startWhenIdentified({ api, config, signal, logger }).catch((err) => {
				if (signal.aborted) return;
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
