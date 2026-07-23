import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "openclaw/plugin-sdk";

// Regression: an inbound DM's reply must target the SENDER, never the agent's own id.
// The bug: the pointer body only said "read with rine_read", giving the model no reply guidance,
// so it self-targeted via the optional rine_send tool using the message's own to_agent_id (= self).
// We assert on the rawBody actually handed to the SDK dispatch seam — behavior, not the internal
// pointerText string shape — so the guarantee survives a rewrite of how the body is assembled.

const dispatchSpy = vi.fn();
vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
	dispatchInboundDirectDmWithRuntime: (params: unknown) => dispatchSpy(params),
}));

vi.mock("../src/outbound.js", () => ({
	sendRineReply: vi.fn(async () => ({})),
}));

import { makeRuntimeDispatcher } from "../src/runtime-dispatch.js";
import type { RineClient } from "../src/rine-client.js";
import type { RineInbound } from "../src/types.js";

function logger(): PluginLogger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

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

const OWN_AGENT_ID = "ef408476-self-agent-id";

function dispatchOf() {
	return makeRuntimeDispatcher({
		cfg: { agents: {} } as never,
		runtime: { channel: {} } as never,
		client: {} as RineClient,
		agentId: OWN_AGENT_ID,
		logger: logger(),
	});
}

async function bodyFor(msg: RineInbound): Promise<string> {
	dispatchSpy.mockReset();
	await dispatchOf()(msg, new AbortController().signal);
	const params = dispatchSpy.mock.calls[0]![0] as Record<string, unknown>;
	return String(params.rawBody);
}

describe("inbound reply routes to the sender, never self", () => {
	it("names the sender handle as the reply target", async () => {
		const body = await bodyFor(inbound());
		expect(body).toContain("hans@castorp.rine.network");
	});

	it("directs the model to the auto-routing reply tool (rine_reply by message_id)", async () => {
		const body = await bodyFor(inbound());
		expect(body).toMatch(/rine_reply/);
		expect(body).toContain("m1"); // the message id the auto-route keys on
	});

	it("never leaks the agent's own id into the pointer body", async () => {
		const body = await bodyFor(inbound());
		// The self-target bug copied to_agent_id (= this agent) into rine_send.to. The pointer
		// must not hand the model its own id as a plausible reply target.
		expect(body).not.toContain(OWN_AGENT_ID);
	});

	it("if rine_send is mentioned at all, its target is the sender — not self", async () => {
		const body = await bodyFor(inbound());
		if (body.includes("rine_send")) {
			expect(body).toMatch(/rine_send[^]*hans@castorp\.rine\.network/);
			expect(body).not.toContain(OWN_AGENT_ID);
		}
	});

	it("uses the sender of each distinct message (not a hardcoded handle)", async () => {
		const body = await bodyFor(inbound({ fromHandle: "settembrini@berghof.rine.network" }));
		expect(body).toContain("settembrini@berghof.rine.network");
		expect(body).not.toContain(OWN_AGENT_ID);
	});
});
