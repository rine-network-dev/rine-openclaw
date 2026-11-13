import { describe, expect, it, vi } from "vitest";

// Regression: an inbound DM's reply must target the SENDER, never the agent's own id.
// The bug: the pointer body only said "read with rine_read", giving the model no reply guidance,
// so it self-targeted via the optional rine_send tool using the message's own to_agent_id (= self).
// We assert on the rawBody actually handed to the SDK dispatch seam — behavior, not the internal
// pointerText string shape — so the guarantee survives a rewrite of how the body is assembled.
//
// The body is also held to the host's real tool surface. It named `rine_reply`, which the plugin
// keeps INTERNAL and never registers, so every inbound burned a round trip per attempt on
// "Tool rine_reply not found" — a defect on every message, 1:1 and group alike, on every install.

const dispatchSpy = vi.fn();
vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
	dispatchInboundDirectDmWithRuntime: (params: unknown) => dispatchSpy(params),
}));

vi.mock("../src/outbound.js", () => ({
	sendRineReply: vi.fn(async () => ({})),
	sendRineText: vi.fn(async () => ({ messageId: "srv-1" })),
}));

import { makeRuntimeDispatcher } from "../src/runtime-dispatch.js";
import { EXPOSED_TOOLS } from "../src/tools.js";
import type { RineClient } from "../src/rine-client.js";
import type { RineInbound } from "../src/types.js";
import { logger, runtimeStub } from "./helpers.js";

function inbound(over: Partial<RineInbound> = {}): RineInbound {
	return {
		id: "m1",
		conversationId: "conv-1",
		fromHandle: "hans@castorp.rine.network",
		type: "rine.v1.dm",
		isGroup: false,
		createdAt: "2026-06-09T00:00:00Z",
		encryptedPayload: "CIPHER",
		encryptionVersion: "hpke-hybrid-v2",
		...over,
	};
}

const OWN_AGENT_ID = "ef408476-self-agent-id";

function dispatchOf() {
	return makeRuntimeDispatcher({
		cfg: { agents: {} } as never,
		runtime: runtimeStub(),
		client: {} as RineClient,
		agentId: OWN_AGENT_ID,
		logger: logger(),
		operator: null,
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

	it("names the message id the agent reads back", async () => {
		const body = await bodyFor(inbound());
		expect(body).toContain("rine_read");
		expect(body).toContain("m1"); // the message id rine_read keys on
	});

	// The host ORs two allowlists and registers only EXPOSED_TOOLS, so a name outside that
	// set is an instruction the model cannot follow — it costs a round trip per attempt and
	// can never succeed. Derived from the registration source, never restated here.
	for (const [label, msg] of [
		["a 1:1 DM", inbound()],
		["a group post", inbound({ isGroup: true, groupHandle: "#ops@acme" })],
		["a suppressed control frame", inbound({ type: "rine.v1.sender_key_distribution" })],
	] as const) {
		it(`names no tool this host does not expose, on ${label}`, async () => {
			const body = await bodyFor(msg);
			const named = body.match(/rine_[a-z0-9_]+/g) ?? [];
			expect(named.length).toBeGreaterThan(0);
			for (const name of named) {
				expect([...EXPOSED_TOOLS] as string[]).toContain(name);
			}
		});
	}

	// A group post is answered to the whole group. The body used to name the poster twice and
	// the group never, so the model was told to answer a group by DM'ing whoever spoke last.
	it("binds a group post's answer to the group, never to the poster", async () => {
		const body = await bodyFor(
			inbound({ isGroup: true, groupHandle: "#ops@acme", conversationId: "g-7" }),
		);
		expect(body).toContain("#ops@acme");
		expect(body).not.toContain(OWN_AGENT_ID);
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
