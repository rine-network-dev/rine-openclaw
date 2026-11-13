import { A2A_CLEARTEXT_NOTICE } from "@rine-network/core";
import { describe, expect, it, vi } from "vitest";

// An A2A message that arrived as cleartext says so in the body that wakes the agent, and the
// mark the read tools return survives the ciphertext strip. A sealed message wakes as before.

const dispatchSpy = vi.fn();
vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
	dispatchInboundDirectDmWithRuntime: (params: unknown) => dispatchSpy(params),
}));

vi.mock("../src/outbound.js", () => ({
	sendRineReply: vi.fn(async () => ({})),
	sendRineText: vi.fn(async () => ({ messageId: "srv-1" })),
}));

import { makeRuntimeDispatcher } from "../src/runtime-dispatch.js";
import type { RineClient } from "../src/rine-client.js";
import { stripCiphertext } from "../src/tools.js";
import type { RineInbound } from "../src/types.js";
import { logger, runtimeStub } from "./helpers.js";

function inbound(over: Partial<RineInbound> = {}): RineInbound {
	return {
		id: "m1",
		conversationId: "conv-1",
		fromHandle: "ext@example.org",
		type: "rine.v1.a2a_message",
		isGroup: false,
		createdAt: "2026-10-13T00:00:00Z",
		encryptedPayload: "W3sidGV4dCI6ICJwbGFpbiJ9XQ",
		encryptionVersion: "none",
		...over,
	};
}

async function bodyFor(msg: RineInbound): Promise<string> {
	dispatchSpy.mockReset();
	await makeRuntimeDispatcher({
		cfg: { agents: {} } as never,
		runtime: runtimeStub(),
		client: {} as RineClient,
		agentId: "ef408476-self-agent-id",
		logger: logger(),
		operator: null,
	})(msg, new AbortController().signal);
	return String((dispatchSpy.mock.calls[0]![0] as Record<string, unknown>).rawBody);
}

describe("A2A cleartext in the wake body", () => {
	it("test_wake_body_when_a2a_cleartext_then_leads_with_notice", async () => {
		const body = await bodyFor(inbound());
		expect(body.startsWith(`[${A2A_CLEARTEXT_NOTICE}] `)).toBe(true);
		expect(body).toContain("rine_read");
	});

	it("test_wake_body_when_sealed_then_carries_no_notice", async () => {
		const sealed = await bodyFor(inbound({ type: "rine.v1.dm", encryptionVersion: "hpke-hybrid-v2" }));
		expect(sealed).not.toContain(A2A_CLEARTEXT_NOTICE);
		const noneButNotA2a = await bodyFor(inbound({ type: "rine.v1.dm" }));
		expect(noneButNotA2a).not.toContain(A2A_CLEARTEXT_NOTICE);
	});
});

describe("the cleartext mark through the read tools' result strip", () => {
	it("test_strip_ciphertext_when_result_is_marked_then_flag_and_notice_survive", () => {
		const out = stripCiphertext({
			id: "m1",
			encrypted_payload: "RAW",
			decrypted: [{ text: "plain" }],
			verified: false,
			a2a_cleartext: true,
			a2a_cleartext_notice: A2A_CLEARTEXT_NOTICE,
		}) as Record<string, unknown>;
		expect(out.encrypted_payload).toBeUndefined();
		expect(out.a2a_cleartext).toBe(true);
		expect(out.a2a_cleartext_notice).toBe(A2A_CLEARTEXT_NOTICE);
	});
});
