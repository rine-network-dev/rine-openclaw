import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
	OpenClawPluginService,
	OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/core";
import { readRineCredentials, resolveRineConfig } from "./config.js";
import { makeOnMessage, makeRuntimeDispatcher } from "./dispatch.js";
import { buildRineClient } from "./rine-client.js";
import type { TransportContext } from "./transports/context.js";
// Statically imported: expose.ts is already in the static graph (index.ts imports
// registerExposeRoute from it), so a dynamic import here only triggers the tsdown
// INEFFECTIVE_DYNAMIC_IMPORT warning without splitting a chunk.
import { runExposeTransport } from "./transports/expose.js";

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
 * The single background notify service. `start(ctx)` resolves transport + creds, owns
 * the AbortController (the service ctx has NO abort signal — see SDK_CONTRACT.md), and
 * runs the transport loop. `stop` aborts it. The long-lived loop lives here, not in a
 * channel `gateway.startAccount`.
 */
export function makeRineService(api: OpenClawPluginApi): OpenClawPluginService {
	let controller: AbortController | undefined;

	return {
		id: SERVICE_ID,
		start(ctx: OpenClawPluginServiceContext): void {
			const logger = ctx.logger ?? api.logger;
			const config = resolveRineConfig(api.pluginConfig ?? {});
			const creds = readRineCredentials(config);
			if (!creds.entry) {
				logger.warn(
					`rine: no credentials.json at ${creds.configDir} — notify service idle (run rine_onboard or set RINE_CONFIG_DIR)`,
				);
				return;
			}
			const agentId = config.agentId ?? creds.entry.client_id;
			const client = buildRineClient(creds);
			controller = new AbortController();
			const signal = controller.signal;

			const dispatch = makeRuntimeDispatcher({
				cfg: api.config,
				runtime: api.runtime,
				client,
				agentId,
				logger,
			});
			const onMessage = makeOnMessage({
				client,
				config,
				agentId,
				logger,
				dispatch,
				signal,
			});
			const tc: TransportContext = {
				client,
				config,
				agentId,
				logger,
				onMessage,
				signal,
				pollUrl: creds.pollUrl,
			};
			logger.info(`rine: notify service starting (transport=${config.transport})`);
			// Fire-and-forget the loop; it owns its own error handling + fallbacks.
			void runTransport(tc).catch((err) => {
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
