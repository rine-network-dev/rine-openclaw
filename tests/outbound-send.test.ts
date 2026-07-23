import { describe, expect, it, vi } from "vitest";

// The fix: the rine channel now exposes an `outbound` adapter + `messaging.targetResolver`
// so OpenClaw's generic `send` message-action can resolve a free-form rine handle and
// deliver it (previously it failed with `Unknown target "<handle>" for rine`). We mock the
// only real boundaries — the rine_send HTTP tool handler and the on-disk credential read.

// vi.mock factories are hoisted above imports — the spies must be created via vi.hoisted.
const { sendHandler, replyHandler, readCredsSpy } = vi.hoisted(() => ({
	sendHandler: vi.fn(async () => ({ id: "srv-msg-1" }) as unknown),
	replyHandler: vi.fn(async () => ({ id: "srv-reply-1" }) as unknown),
	readCredsSpy: vi.fn(() => ({
		configDir: "/tmp/rine-cfg",
		apiUrl: "https://rine.network",
		entry: { client_id: "c", client_secret: "s" },
		pollUrl: undefined as string | undefined,
	})),
}));

vi.mock("@rine-network/mcp/tools", () => ({
	tools: [
		{ name: "rine_reply", description: "", inputSchema: {}, handler: replyHandler },
		{ name: "rine_send", description: "", inputSchema: {}, handler: sendHandler },
	],
}));

vi.mock("../src/config.js", () => ({
	// Minimal config resolver: only the fields outbound.sendText reads (agentId) matter.
	// Mirrors the real precedence — channels.rine over plugins.entries.rine.config.
	resolveRineConfigFromCfg: (cfg: unknown = {}) => {
		const root = (cfg ?? {}) as Record<string, any>;
		const channelCfg = (root.channels?.rine ?? {}) as Record<string, unknown>;
		const entryCfg = (root.plugins?.entries?.rine?.config ?? {}) as Record<string, unknown>;
		const raw = { ...entryCfg, ...channelCfg };
		return {
			transport: "sse",
			configDir: raw.configDir as string | undefined,
			agentId: raw.agentId as string | undefined,
			baseUrl: undefined,
			pollIntervalMs: 60_000,
			reconnectBaseMs: 3_000,
			reconnectMaxMs: 300_000,
			a2aAcceptCleartext: true,
			allowFrom: ["*"],
		};
	},
	readRineCredentials: () => readCredsSpy(),
}));

import { rinePlugin } from "../src/channel.js";
import { sendRineReply, sendRineText } from "../src/outbound.js";
import type { RineClient } from "../src/rine-client.js";
import type { RineInbound } from "../src/types.js";

const fakeClient = { toolContext: { tag: "ctx" } } as unknown as RineClient;

function inbound(over: Partial<RineInbound> = {}): RineInbound {
	return {
		id: "m1",
		conversationId: "conv-1",
		fromHandle: "hans@castorp.rine.network",
		type: "rine.v1.dm",
		isGroup: false,
		createdAt: "2026-06-09T00:00:00Z",
		encryptedPayload: "CIPHER",
		encryptionVersion: "hpke-v1",
		...over,
	};
}

// Verify-only reference impl: openclaw already replies IN-PLACE — the
// lifted rine_reply handler keys on the inbound message id, so POST /messages/{id}/reply
// preserves the conversation (no fork). The reply type is the rine_reply default; openclaw
// has no type-based loop guard (dispatch dedupes on msg.id), so a default reply is terminal
// toward a peer Eve (correct per the type-preserving design).
describe("sendRineReply (reply-in-place via lifted rine_reply)", () => {
	it("targets the inbound message id so the reply stays in its conversation", async () => {
		replyHandler.mockClear();
		await sendRineReply(fakeClient, inbound({ id: "m-42" }), "the answer");
		expect(replyHandler).toHaveBeenCalledTimes(1);
		expect(replyHandler).toHaveBeenCalledWith(fakeClient.toolContext, {
			message_id: "m-42",
			payload: { text: "the answer" },
		});
		// It does NOT fork via rine_send.
		expect(sendHandler).not.toHaveBeenCalled();
	});
});

// Minimal stand-in for ChannelOutboundContext — sendText only reads cfg/to/text.
function outboundCtx(over: Record<string, unknown> = {}) {
	return { cfg: {}, to: "alice@acme", text: "hi", ...over } as never;
}

describe("sendRineText (active send via lifted rine_send)", () => {
	it("encrypts+posts via rine_send with {to, payload:{text}} and returns the server id", async () => {
		sendHandler.mockClear();
		const res = await sendRineText(fakeClient, "alice@acme", "hello");
		expect(sendHandler).toHaveBeenCalledTimes(1);
		expect(sendHandler).toHaveBeenCalledWith(fakeClient.toolContext, {
			to: "alice@acme",
			payload: { text: "hello" },
		});
		expect(res).toEqual({ messageId: "srv-msg-1" });
	});

	it("passes `from` (sending agent) only when provided — multi-agent disambiguation", async () => {
		sendHandler.mockClear();
		await sendRineText(fakeClient, "alice@acme", "hi", "agent-uuid-1");
		expect(sendHandler).toHaveBeenCalledWith(fakeClient.toolContext, {
			to: "alice@acme",
			payload: { text: "hi" },
			from: "agent-uuid-1",
		});
	});

	it("falls back to messageId 'unknown' when the response carries no id", async () => {
		sendHandler.mockClear();
		sendHandler.mockResolvedValueOnce({} as never);
		const res = await sendRineText(fakeClient, "alice@acme", "hi");
		expect(res).toEqual({ messageId: "unknown" });
	});
});

describe("rinePlugin.outbound.resolveTarget", () => {
	const resolve = rinePlugin.outbound!.resolveTarget!;

	it("accepts any non-empty handle/UUID and trims it", () => {
		expect(resolve({ to: "  alice@acme " })).toEqual({ ok: true, to: "alice@acme" });
		expect(resolve({ to: "#ops@acme" })).toEqual({ ok: true, to: "#ops@acme" });
	});

	it("rejects a blank target with an actionable error", () => {
		const r = resolve({ to: "   " });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.message).toMatch(/target handle or UUID/);
	});
});

describe("rinePlugin.messaging.targetResolver.looksLikeId", () => {
	const looksLikeId = rinePlugin.messaging!.targetResolver!.looksLikeId!;

	it("treats any non-empty string as a valid rine id (bypasses the Unknown-target directory search)", () => {
		expect(looksLikeId("alice@acme")).toBe(true);
		expect(looksLikeId("a8e7f686-1234")).toBe(true);
	});

	it("does not claim blank input as an id", () => {
		expect(looksLikeId("")).toBe(false);
		expect(looksLikeId("   ")).toBe(false);
	});
});

describe("rinePlugin.outbound.sendText", () => {
	it("delivers the agent's text to the resolved target via rine_send", async () => {
		sendHandler.mockClear();
		const res = await rinePlugin.outbound!.sendText!(
			outboundCtx({ to: "bob@lab", text: "ack" }),
		);
		expect(res).toEqual({ channel: "rine", messageId: "srv-msg-1" });
		expect(sendHandler).toHaveBeenCalledWith(expect.anything(), {
			to: "bob@lab",
			payload: { text: "ack" },
		});
	});

	it("forwards a configured channels.rine.agentId as the sending `from`", async () => {
		sendHandler.mockClear();
		await rinePlugin.outbound!.sendText!(
			outboundCtx({ cfg: { channels: { rine: { agentId: "agent-uuid-1" } } } as never }),
		);
		expect(sendHandler).toHaveBeenCalledWith(expect.anything(), {
			to: "alice@acme",
			payload: { text: "hi" },
			from: "agent-uuid-1",
		});
	});

	it("throws an actionable error when no rine credentials are resolved", async () => {
		readCredsSpy.mockReturnValueOnce({
			configDir: "/tmp/rine-cfg",
			apiUrl: "https://rine.network",
			entry: undefined,
			pollUrl: undefined,
		} as never);
		await expect(rinePlugin.outbound!.sendText!(outboundCtx())).rejects.toThrow(
			/no credentials/,
		);
	});
});
