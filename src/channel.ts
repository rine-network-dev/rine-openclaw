import type { ChannelPlugin } from "openclaw/plugin-sdk";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/core";
import { patchTopLevelChannelConfigSection } from "openclaw/plugin-sdk/setup";
import { readRineCredentials, resolveRineConfigFromCfg } from "./config.js";
import { DEFAULT_ACCOUNT_ID } from "./constants.js";
import { sendRineText } from "./outbound.js";
import { buildRineClient } from "./rine-client.js";

/** Single-account model for the rine channel (the credentialed agent). */
export interface RineAccount {
	accountId: string;
}

/**
 * Outbound adapter — lets OpenClaw's generic `send` message-action deliver to an
 * arbitrary rine target. The channel was previously "thin" (no outbound), so core
 * could neither resolve a rine handle nor deliver, and the agent's generic `send`
 * failed with `Unknown target "<handle>" for rine`. `deliveryMode:"direct"` because
 * rine delivers over its own HTTP API, not an OpenClaw gateway socket. The
 * inbound→reply auto-path (dispatch `deliver` → `sendRineReply`) is unchanged.
 */
const rineOutbound: ChannelOutboundAdapter = {
	deliveryMode: "direct",
	// rine targets are free-form handles (name@org, #group@org) or agent UUIDs —
	// any non-empty string is valid; reject only blank to surface a clear error.
	resolveTarget: ({ to }) => {
		const trimmed = to?.trim();
		if (!trimmed) {
			return {
				ok: false,
				error: new Error(
					"Delivering to rine needs a target handle or UUID (e.g. alice@acme or #ops@acme).",
				),
			};
		}
		return { ok: true, to: trimmed };
	},
	sendText: async (ctx) => {
		const config = resolveRineConfigFromCfg(ctx.cfg);
		const creds = readRineCredentials(config);
		if (!creds.entry) {
			throw new Error(
				"rine: no credentials at the resolved config dir — run rine_onboard or set RINE_CONFIG_DIR.",
			);
		}
		const client = buildRineClient(creds);
		const { messageId } = await sendRineText(client, ctx.to, ctx.text, config.agentId);
		return { channel: "rine", messageId };
	},
};

/**
 * Minimal but type-valid `ChannelPlugin` for rine. Required fields only:
 * id / meta / capabilities / config. Inbound delivery + outbound replies are owned by
 * the notify service + dispatch seam (the canonical reply path lives on the runtime
 * singleton, available to the service), so the channel object stays thin — it advertises
 * the `rine` channel so sessions key as `agent:<id>:rine:<kind>:<peer>` and the channel
 * surfaces in `plugins inspect`. See SDK_CONTRACT.md.
 */
export const rinePlugin: ChannelPlugin<RineAccount> = {
	id: "rine",
	meta: {
		id: "rine",
		label: "rine",
		selectionLabel: "rine",
		detailLabel: "rine network",
		docsPath: "/channels/rine",
		docsLabel: "rine",
		blurb: "Agent-to-agent E2EE messaging over the rine network (A2A relay / SSE / poll).",
		systemImage: "antenna.radiowaves.left.and.right",
		order: 120,
		showConfigured: true,
	},
	capabilities: {
		chatTypes: ["direct", "group"],
		reply: true,
		threads: true,
		media: false,
	},
	reload: { configPrefixes: ["channels.rine"] },
	config: {
		listAccountIds: () => [DEFAULT_ACCOUNT_ID],
		resolveAccount: (_cfg, accountId) => ({
			accountId: accountId ?? DEFAULT_ACCOUNT_ID,
		}),
		defaultAccountId: () => DEFAULT_ACCOUNT_ID,
	},
	/**
	 * Setup wizard: scaffolds a default `channels.rine` block on first run so
	 * users get a working channel without hand-editing openclaw.json.
	 * Rine credentials live in ~/.config/rine (not openclaw.json), so
	 * `credentials: []` — the wizard completes immediately after the prepare hook.
	 */
	setupWizard: {
		channel: "rine",
		status: {
			configuredLabel: "rine configured",
			unconfiguredLabel: "rine not configured",
			configuredHint: "Receiving messages via rine network",
			unconfiguredHint: "Run 'openclaw plugins setup rine' to activate",
			resolveConfigured: ({ cfg }) => {
				const ch = (cfg as Record<string, unknown>).channels as
					| Record<string, unknown>
					| undefined;
				return typeof ch?.rine === "object" && ch.rine !== null;
			},
		},
		credentials: [],
		prepare: ({ cfg }) => {
			const ch = (cfg as Record<string, unknown>).channels as
				| Record<string, unknown>
				| undefined;
			if (typeof ch?.rine === "object" && ch.rine !== null) return;
			const patched = patchTopLevelChannelConfigSection({
				cfg,
				channel: "rine",
				patch: { transport: "sse", healthMonitor: { enabled: false } },
			});
			return { cfg: patched };
		},
	},
	outbound: rineOutbound,
	/**
	 * Tell core that any non-empty string is a valid rine target. Without this,
	 * core's directory-search path treats a free-form `name@org` handle as a
	 * display-name (it matches none of the built-in id heuristics) and emits
	 * `Unknown target "<handle>" for rine` before delivery is ever attempted.
	 */
	messaging: {
		targetResolver: {
			hint: "Use a rine handle (name@org or #group@org) or an agent UUID.",
			looksLikeId: (raw) => Boolean(raw?.trim()),
		},
	},
};
