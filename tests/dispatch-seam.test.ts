import { describe, expect, it, vi } from "vitest";

// Capture the params handed to the SDK helper so we can assert the dispatch contract
// (peer, pointer body, deliver wiring, error re-throw) without a live OpenClaw runtime.
const dispatchSpy = vi.fn();
vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
	dispatchInboundDirectDmWithRuntime: (params: unknown) => dispatchSpy(params),
}));

const sendReplySpy = vi.fn(async (_client: unknown, _msg: unknown, _text: string) => ({}));
const sendTextSpy = vi.fn(
	async (_client: unknown, _to: string, _text: string, _from?: string) => ({ messageId: "srv-1" }),
);
vi.mock("../src/outbound.js", () => ({
	sendRineReply: (client: unknown, msg: unknown, text: string) => sendReplySpy(client, msg, text),
	sendRineText: (client: unknown, to: string, text: string, from?: string) =>
		sendTextSpy(client, to, text, from),
}));

import { makeRuntimeDispatcher } from "../src/runtime-dispatch.js";
import type { RineClient } from "../src/rine-client.js";
import type { RineInbound } from "../src/types.js";
import { logger, runtimeStub } from "./helpers.js";

function inbound(over: Partial<RineInbound> = {}): RineInbound {
	return {
		id: "m1",
		conversationId: "conv-1",
		fromHandle: "alice@lab",
		type: "rine.v1.dm",
		isGroup: false,
		createdAt: "2026-06-09T00:00:00Z",
		encryptedPayload: "CIPHER",
		encryptionVersion: "hpke-hybrid-v2",
		...over,
	};
}

function makeDispatcher() {
	const log = logger();
	const client = {} as RineClient;
	const dispatch = makeRuntimeDispatcher({
		cfg: { agents: {} } as never,
		runtime: runtimeStub(),
		client,
		agentId: "agent-1",
		logger: log,
	});
	return { dispatch, log, client };
}

describe("makeRuntimeDispatcher (dispatch seam)", () => {
	it("routes a DM through the direct-dm helper with a pointer body (no ciphertext)", async () => {
		dispatchSpy.mockReset();
		const { dispatch } = makeDispatcher();
		await dispatch(inbound(), new AbortController().signal);

		expect(dispatchSpy).toHaveBeenCalledTimes(1);
		const params = dispatchSpy.mock.calls[0]![0] as Record<string, unknown>;
		// Regression guard: the original bug passed cfg:undefined + no runtime.
		expect(params.cfg).toBeDefined();
		expect(params.runtime).toBeDefined();
		expect(params.channel).toBe("rine");
		expect(params.accountId).toBe("agent-1");
		expect(params.peer).toEqual({ kind: "direct", id: "alice@lab" });
		expect(params.messageId).toBe("m1");
		// Pointer body only — the ciphertext must never enter the agent transcript.
		expect(params.rawBody).toContain("rine_read");
		expect(params.rawBody).toContain("m1");
		expect(JSON.stringify(params)).not.toContain("CIPHER");
		// openclaw push-injects NO rine transcript (no double-context) —
		// the inbound carries only the pointer line, never role-tagged turns.
		expect(params.rawBody).not.toContain("[received]");
		expect(params.rawBody).not.toContain("[sent]");
		// The answer must be bound to the SENDER, never to this agent's own id.
		expect(params.rawBody).toContain("alice@lab");
		// rine_reply is an INTERNAL tool the host never registers: naming it in the body
		// spent every turn on tool calls the runtime answered "Tool rine_reply not found".
		expect(params.rawBody).not.toMatch(/rine_reply/);
		expect(params.rawBody).not.toContain("agent-1");
		// ISO createdAt is converted to an epoch-ms number for the SDK contract.
		expect(typeof params.timestamp).toBe("number");
	});

	it("maps a group message onto peer.id = conversationId (v0.1 group ride)", async () => {
		dispatchSpy.mockReset();
		const { dispatch } = makeDispatcher();
		await dispatch(
			inbound({ isGroup: true, groupHandle: "#ops@acme", conversationId: "g-7" }),
			new AbortController().signal,
		);
		const params = dispatchSpy.mock.calls[0]![0] as Record<string, unknown>;
		expect(params.peer).toEqual({ kind: "direct", id: "g-7" });
		expect(params.conversationLabel).toContain("g-7");
	});

	it("deliver(payload.text) routes the agent reply back out via sendRineReply", async () => {
		dispatchSpy.mockReset();
		sendReplySpy.mockReset();
		dispatchSpy.mockImplementation(async (params: Record<string, unknown>) => {
			const deliver = params.deliver as (p: { text: string }) => Promise<void>;
			await deliver({ text: "hello back" });
		});
		const { dispatch, client } = makeDispatcher();
		await dispatch(inbound(), new AbortController().signal);
		expect(sendReplySpy).toHaveBeenCalledWith(client, expect.objectContaining({ id: "m1" }), "hello back");
	});

	// A one-way webhook self-send wakes the turn but must NOT auto-reply
	// (the reply targets the agent itself → "Cannot reply to your own message").
	it("wakes exactly one turn but emits NO auto-reply for a rine.v1.webhook self-send", async () => {
		dispatchSpy.mockReset();
		sendReplySpy.mockReset();
		dispatchSpy.mockImplementation(async (params: Record<string, unknown>) => {
			const deliver = params.deliver as (p: { text: string }) => Promise<void>;
			await deliver({ text: "webhook acknowledged" });
		});
		const { dispatch } = makeDispatcher();
		await dispatch(
			inbound({ type: "rine.v1.webhook", selfSend: true }),
			new AbortController().signal,
		);
		expect(dispatchSpy).toHaveBeenCalledTimes(1); // exactly one agent turn
		expect(sendReplySpy).not.toHaveBeenCalled(); // zero outbound replies
	});

	it("suppresses the auto-reply for any from==to self-send (even a non-webhook type)", async () => {
		dispatchSpy.mockReset();
		sendReplySpy.mockReset();
		dispatchSpy.mockImplementation(async (params: Record<string, unknown>) => {
			const deliver = params.deliver as (p: { text: string }) => Promise<void>;
			await deliver({ text: "output" });
		});
		const { dispatch } = makeDispatcher();
		await dispatch(inbound({ type: "rine.v1.dm", selfSend: true }), new AbortController().signal);
		expect(sendReplySpy).not.toHaveBeenCalled();
	});

	// x402 compat: the three payment frames wake the agent to ACT (pay via the rine_pay
	// tool, read the receipt) but a canned text auto-reply would be injected into the payment
	// thread and corrupt the handshake — so it must be suppressed exactly like a one-way event.
	for (const type of [
		"rine.v1.x402_payment_required",
		"rine.v1.x402_payment",
		"rine.v1.x402_receipt",
	]) {
		it(`wakes one turn but emits NO auto-reply for an inbound ${type} frame`, async () => {
			dispatchSpy.mockReset();
			sendReplySpy.mockReset();
			dispatchSpy.mockImplementation(async (params: Record<string, unknown>) => {
				const deliver = params.deliver as (p: { text: string }) => Promise<void>;
				await deliver({ text: "here is my reply to your payment frame" });
			});
			const { dispatch } = makeDispatcher();
			await dispatch(inbound({ type }), new AbortController().signal);
			expect(dispatchSpy).toHaveBeenCalledTimes(1); // agent still wakes (can call rine_pay)
			expect(sendReplySpy).not.toHaveBeenCalled(); // zero outbound replies into the thread
		});
	}

	// Guard is type-scoped: a non-x402 type that merely embeds an x402 substring still replies.
	it("still auto-replies for a normal DM whose type is not exactly an x402 frame", async () => {
		dispatchSpy.mockReset();
		sendReplySpy.mockReset();
		dispatchSpy.mockImplementation(async (params: Record<string, unknown>) => {
			const deliver = params.deliver as (p: { text: string }) => Promise<void>;
			await deliver({ text: "ordinary reply" });
		});
		const { dispatch, client } = makeDispatcher();
		await dispatch(inbound({ type: "rine.v1.x402_payment_note" }), new AbortController().signal);
		expect(sendReplySpy).toHaveBeenCalledWith(client, expect.objectContaining({ id: "m1" }), "ordinary reply");
	});

	// A catch-up/replayed frame wakes the agent to ACT but must not auto-reply.
	it("suppresses the auto-reply for a replayed (catch-up) frame, still dispatching the turn", async () => {
		dispatchSpy.mockReset();
		sendReplySpy.mockReset();
		dispatchSpy.mockImplementation(async (params: Record<string, unknown>) => {
			const deliver = params.deliver as (p: { text: string }) => Promise<void>;
			await deliver({ text: "reply text" });
		});
		const { dispatch } = makeDispatcher();
		await dispatch(inbound(), new AbortController().signal, { replayed: true });
		expect(dispatchSpy).toHaveBeenCalledTimes(1);
		expect(sendReplySpy).not.toHaveBeenCalled();
	});

	it("still auto-replies for a normal live DM (replayed:false / opts absent)", async () => {
		dispatchSpy.mockReset();
		sendReplySpy.mockReset();
		dispatchSpy.mockImplementation(async (params: Record<string, unknown>) => {
			const deliver = params.deliver as (p: { text: string }) => Promise<void>;
			await deliver({ text: "hi" });
		});
		const { dispatch, client } = makeDispatcher();
		await dispatch(inbound(), new AbortController().signal, { replayed: false });
		expect(sendReplySpy).toHaveBeenCalledWith(client, expect.objectContaining({ id: "m1" }), "hi");
	});

	it("re-throws on onDispatchError so makeOnMessage preserves at-least-once", async () => {
		dispatchSpy.mockReset();
		dispatchSpy.mockImplementation(async (params: Record<string, unknown>) => {
			const onDispatchError = params.onDispatchError as (e: unknown, i: { kind: string }) => void;
			onDispatchError(new Error("turn boom"), { kind: "dispatch" });
		});
		const { dispatch } = makeDispatcher();
		await expect(dispatch(inbound(), new AbortController().signal)).rejects.toThrow("turn boom");
	});

	it("onRecordError is non-fatal (logged, not thrown)", async () => {
		dispatchSpy.mockReset();
		dispatchSpy.mockImplementation(async (params: Record<string, unknown>) => {
			const onRecordError = params.onRecordError as (e: unknown) => void;
			onRecordError(new Error("record boom"));
		});
		const { dispatch, log } = makeDispatcher();
		await expect(dispatch(inbound(), new AbortController().signal)).resolves.toBeUndefined();
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("session-record error"));
	});

	it("throws immediately on an already-aborted signal (no dispatch)", async () => {
		dispatchSpy.mockReset();
		const { dispatch } = makeDispatcher();
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(dispatch(inbound(), ctrl.signal)).rejects.toThrow();
		expect(dispatchSpy).not.toHaveBeenCalled();
	});

	// A GROUP is answered by SENDING to the group. Before this the group inbound took the 1:1
	// reply path, the lifted rine_reply handler refused it one GET earlier ("Cannot determine
	// recipient from message"), and the answer died in a single log line — the agent wrote a
	// complete answer into its own session every time and the group heard nothing.
	it("answers a group post by sending to the group, never by replying", async () => {
		dispatchSpy.mockReset();
		sendReplySpy.mockReset();
		sendTextSpy.mockReset();
		dispatchSpy.mockImplementation(async (params: Record<string, unknown>) => {
			const deliver = params.deliver as (p: { text: string }) => Promise<void>;
			await deliver({ text: "the group answer" });
		});
		const { dispatch, client } = makeDispatcher();
		await dispatch(
			inbound({ isGroup: true, groupHandle: "#ops@acme", conversationId: "g-7" }),
			new AbortController().signal,
		);
		expect(sendTextSpy).toHaveBeenCalledWith(client, "#ops@acme", "the group answer", "agent-1");
		expect(sendReplySpy).not.toHaveBeenCalled();
	});

	// isGroup is true whenever a group handle OR a bare group id is present, so a group frame
	// can arrive with no handle. A group UUID typechecks as a send target and is then encrypted
	// 1:1 and rejected server-side, so the only correct move is to refuse loudly.
	it("sends nothing and logs when a group inbound carries no group handle", async () => {
		dispatchSpy.mockReset();
		sendReplySpy.mockReset();
		sendTextSpy.mockReset();
		dispatchSpy.mockImplementation(async (params: Record<string, unknown>) => {
			const deliver = params.deliver as (p: { text: string }) => Promise<void>;
			await deliver({ text: "the group answer" });
		});
		const { dispatch, log } = makeDispatcher();
		await dispatch(
			inbound({ isGroup: true, groupId: "3f0d1f5e-group-uuid" }),
			new AbortController().signal,
		);
		expect(sendTextSpy).not.toHaveBeenCalled();
		expect(sendReplySpy).not.toHaveBeenCalled();
		expect(log.error).toHaveBeenCalledWith(expect.stringContaining("no group handle"));
	});

	// The pointer body is the only thing the model reads, and it used to name the poster twice
	// and the group never — telling the model to answer a group post by DM'ing whoever spoke last.
	it("tells the model a group post is answered to the group, not to the sender", async () => {
		dispatchSpy.mockReset();
		const { dispatch } = makeDispatcher();
		await dispatch(
			inbound({ isGroup: true, groupHandle: "#ops@acme", conversationId: "g-7" }),
			new AbortController().signal,
		);
		const params = dispatchSpy.mock.calls[0]![0] as Record<string, unknown>;
		expect(params.rawBody).toContain("#ops@acme");
		expect(params.rawBody).not.toMatch(/rine_reply/);
	});

	// A control frame's payload is parsed as JSON by the peer, and a reply mirrors the original's
	// type — so an auto-answer lands in the peer's inbox wearing a crypto envelope's label.
	// Measured live: a row typed rine.v1.sender_key_distribution carrying an LLM's chat prose.
	for (const type of ["rine.v1.sender_key_distribution", "rine.v1.group_invite"]) {
		it(`wakes one turn but emits NO auto-reply for an inbound ${type} control frame`, async () => {
			dispatchSpy.mockReset();
			sendReplySpy.mockReset();
			sendTextSpy.mockReset();
			dispatchSpy.mockImplementation(async (params: Record<string, unknown>) => {
				const deliver = params.deliver as (p: { text: string }) => Promise<void>;
				await deliver({ text: "sure, happy to help with that!" });
			});
			const { dispatch } = makeDispatcher();
			await dispatch(inbound({ type }), new AbortController().signal);
			expect(dispatchSpy).toHaveBeenCalledTimes(1); // the agent still wakes to act
			expect(sendReplySpy).not.toHaveBeenCalled();
			expect(sendTextSpy).not.toHaveBeenCalled();
		});
	}
});
