import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { rinePlugin } from "./src/channel.js";
import { resolveRineConfigFromCfg, readRineCredentials } from "./src/config.js";
import { buildRineClient } from "./src/rine-client.js";
import { makeRineService } from "./src/service.js";
import { registerRineTools } from "./src/tools.js";
import { registerExposeRoute } from "./src/transports/expose.js";

/**
 * Structural annotation for the entry object.
 *
 * `defineChannelPluginEntry` returns `DefinedChannelPluginEntry<TPlugin>`, and both that
 * type and the `ChannelConfigSchema` it carries are host-private on 2026.9.x — no
 * `openclaw/plugin-sdk/*` subpath exports either, and neither does `JsonSchemaObject`.
 * Without an annotation TypeScript refuses to emit our `index.d.ts` (TS2742: "cannot be
 * named without a reference to ./node_modules/openclaw/dist/types.config-*.js"). Mirror
 * the shape locally, using only public types, so the published declaration stays portable.
 */
export type RineChannelPluginEntry = {
	id: string;
	name: string;
	description: string;
	configSchema: {
		schema: unknown;
		uiHints?: Record<string, ChannelConfigUiHint>;
	};
	register: (api: OpenClawPluginApi) => void;
	channelPlugin: typeof rinePlugin;
	setChannelRuntime?: (runtime: PluginRuntime) => void;
};

/**
 * Channel plugin entry. What `defineChannelPluginEntry` does with each registration mode
 * is the HOST's decision, read from openclaw 2026.9.1's own
 * `src/plugin-sdk/core.ts` (the `register` it returns), not assumed:
 *
 *   cli-metadata   — `registerCliMetadata` only. No channel, no runtime.
 *   tool-discovery — `registerFull` + `registerCapabilities`, then returns. NO channel is
 *                    registered and `setChannelRuntime` is never called, so the tools are
 *                    enumerable with no channel runtime behind them (tests/register-full.test.ts
 *                    pins this).
 *   discovery      — channel + runtime, then `registerCliMetadata` + `registerCapabilities`.
 *   full           — channel + runtime, then all three registrars.
 *
 * So `registerFull` runs in TWO modes, and the channel is registered in two of the four —
 * "every load mode" is false on this host, in both halves. Top-level module eval stays
 * side-effect-free (no network, no cred reads); all work happens inside registration.
 */
const rineChannelPluginEntry: RineChannelPluginEntry = defineChannelPluginEntry({
	id: "rine",
	name: "rine",
	description: manifest.description,
	plugin: rinePlugin,
	configSchema: { schema: manifest.configSchema, uiHints: manifest.uiHints },
	registerFull(api: OpenClawPluginApi) {
		const config = resolveRineConfigFromCfg(api.config);
		const creds = readRineCredentials(config);
		const client = buildRineClient(creds);
		registerRineTools(api, client.toolContext, {
			autoPay: config.payments.autoPay,
			agentId: config.agentId,
		});
		registerExposeRoute(api);
		api.registerService(makeRineService(api));
	},
});

export default rineChannelPluginEntry;
