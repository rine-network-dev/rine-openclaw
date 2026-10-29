import { describe, expect, it } from "vitest";
import { A2A_CLEARTEXT_NOTICE, type MessageRead } from "@rine-network/core";
import { pointerText } from "../src/runtime-dispatch.js";
import type { RineInbound } from "../src/types.js";
import {
	isAllowed,
	normalizeA2A,
	normalizeRineEvent,
	normalizeStandardWebhook,
	readabilityArgsFor,
} from "../src/inbound.js";

function msg(over: Partial<MessageRead> = {}): MessageRead {
	return {
		id: "m1",
		conversation_id: "conv-1",
		type: "rine.v1.dm",
		encrypted_payload: "CIPHER",
		encryption_version: "hpke-hybrid-v2",
		sender_handle: "alice@lab",
		created_at: "2026-06-09T00:00:00Z",
		...over,
	};
}

describe("normalizeRineEvent", () => {
	it("maps a direct MessageRead to RineInbound", () => {
		const r = normalizeRineEvent(msg());
		expect(r).toMatchObject({
			id: "m1",
			conversationId: "conv-1",
			fromHandle: "alice@lab",
			isGroup: false,
			encryptionVersion: "hpke-hybrid-v2",
		});
	});

	it("flags group messages from group_handle", () => {
		const r = normalizeRineEvent(msg({ group_handle: "#ops@acme", group_id: "g1" }));
		expect(r.isGroup).toBe(true);
		expect(r.groupHandle).toBe("#ops@acme");
		expect(r.groupId).toBe("g1");
	});

	it("falls back to from_agent_id when handle absent", () => {
		const r = normalizeRineEvent(msg({ sender_handle: undefined, from_agent_id: "uuid-x" }));
		expect(r.fromHandle).toBe("uuid-x");
	});

	// from==to marks a self-send (the Funnel webhook shape) → no auto-reply.
	it("flags a self-send when from_agent_id == to_agent_id", () => {
		const r = normalizeRineEvent(
			msg({ type: "rine.v1.webhook", from_agent_id: "ag-1", to_agent_id: "ag-1" }),
		);
		expect(r.selfSend).toBe(true);
	});

	it("does not flag a normal inbound (from != to) as a self-send", () => {
		const r = normalizeRineEvent(msg({ from_agent_id: "ag-1", to_agent_id: "ag-2" }));
		expect(r.selfSend).toBe(false);
	});

	it("does not flag a self-send when agent ids are absent", () => {
		expect(normalizeRineEvent(msg()).selfSend).toBe(false);
	});
});

describe("readabilityArgsFor", () => {
	const ctx = { client: {} as never, configDir: "/tmp/cfg", agentId: "agent-1" };

	it("hands the server's created_at to core's decrypt gate", () => {
		const args = readabilityArgsFor(normalizeRineEvent(msg()), ctx);
		expect(args.createdAt).toBe("2026-06-09T00:00:00Z");
	});

	it("maps an absent sender and group to null, never undefined", () => {
		const args = readabilityArgsFor(normalizeRineEvent(msg()), ctx);
		expect(args.fromAgentId).toBeNull();
		expect(args.groupId).toBeNull();
	});
});

describe("normalizeStandardWebhook", () => {
	it("unwraps a {message} envelope", () => {
		const r = normalizeStandardWebhook({ message: msg() });
		expect(r?.id).toBe("m1");
	});
	it("accepts a bare MessageRead body", () => {
		expect(normalizeStandardWebhook(msg())?.id).toBe("m1");
	});
	it("returns undefined for junk", () => {
		expect(normalizeStandardWebhook({ nope: true })).toBeUndefined();
		expect(normalizeStandardWebhook(null)).toBeUndefined();
	});
});

describe("normalizeA2A", () => {
	it("normalizes an artifactUpdate envelope to the same RineInbound shape", () => {
		const r = normalizeA2A({
			result: {
				artifactUpdate: {
					taskId: "task-7",
					from: "bob@org",
					artifact: { encrypted_payload: "X", encryption_version: "hpke-hybrid-v2" },
				},
			},
		});
		expect(r).toMatchObject({ id: "task-7", conversationId: "task-7", fromHandle: "bob@org" });
	});
	it("reads a push with no stated version as the cleartext A2A message it is on the wire", () => {
		const r = normalizeA2A({
			result: { artifactUpdate: { taskId: "task-8", artifact: { artifactId: "a-1" } } },
		});
		expect(r).toMatchObject({ type: "rine.v1.a2a_message", encryptionVersion: "none" });
		expect(pointerText(r as RineInbound)).toContain(A2A_CLEARTEXT_NOTICE);
	});
	it("returns undefined when not an A2A envelope", () => {
		expect(normalizeA2A({ message: msg() })).toBeUndefined();
	});
});

describe("isAllowed", () => {
	it("* allows everything", () => {
		expect(isAllowed("anyone@x", ["*"])).toBe("allowed");
	});
	it("empty list allows everything", () => {
		expect(isAllowed("anyone@x", [])).toBe("allowed");
	});
	it("exact handle match", () => {
		expect(isAllowed("alice@lab", ["alice@lab"])).toBe("allowed");
		expect(isAllowed("bob@lab", ["alice@lab"])).toBe("quarantined");
	});
	it("@org scope match", () => {
		expect(isAllowed("alice@lab", ["@lab"])).toBe("allowed");
		expect(isAllowed("alice@evil", ["@lab"])).toBe("quarantined");
	});
});
