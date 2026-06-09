import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "./constants.js";

/** Single-account model for the rine channel (the credentialed agent). */
export interface RineAccount {
	accountId: string;
}

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
};
