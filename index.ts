import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { rinePlugin } from "./src/channel.js";
import { resolveRineConfigFromCfg, readRineCredentials } from "./src/config.js";
import { buildRineClient } from "./src/rine-client.js";
import { makeRineService } from "./src/service.js";
import { registerRineTools } from "./src/tools.js";
import { registerExposeRoute } from "./src/transports/expose.js";

/**
 * Channel plugin entry. `defineChannelPluginEntry` registers the rine channel in every
 * load mode; `registerFull` runs only in full (non-setup) mode and wires the tools,
 * the always-on EXPOSE route, and the notify service. Top-level module eval stays
 * side-effect-free (no network, no cred reads) — all work happens inside registration.
 */
export default defineChannelPluginEntry({
	id: "rine",
	name: "rine",
	description: manifest.description,
	plugin: rinePlugin,
	configSchema: { schema: manifest.configSchema, uiHints: manifest.uiHints },
	registerFull(api: OpenClawPluginApi) {
		const config = resolveRineConfigFromCfg(api.config);
		const creds = readRineCredentials(config);
		const client = buildRineClient(creds);
		registerRineTools(api, client.toolContext, { autoPay: config.payments.autoPay });
		registerExposeRoute(api);
		api.registerService(makeRineService(api));
	},
});
