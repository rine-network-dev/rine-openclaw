import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "openclaw/plugin-sdk";

// Capture the params handed to the SDK helper so we can assert the dispatch contract
// (peer, pointer body, deliver wiring, error re-throw) without a live OpenClaw runtime.
const dispatchSpy = vi.fn();
vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
	dispatchInboundDirectDmWithRuntime: (params: unknown) => dispatchSpy(params),
}));

const sendReplySpy = vi.fn(async (_client: unknown, _msg: unknown, _text: string) => ({}));
vi.mock("../src/outbound.js", () => ({
	sendRineReply: (client: unknown, msg: unknown, text: string) => sendReplySpy(client, msg, text),
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
		fromHandle: "alice@lab",
		type: "rine.v1.dm",
		isGroup: false,
		createdAt: "2026-06-09T00:00:00Z",
		encryptedPayload: "CIPHER",
		encryptionVersion: "hpke-v1",
		...over,
	};
}

function makeDispatcher() {
	const log = logger();
	const client = {} as RineClient;
	const dispatch = makeRuntimeDispatcher({
		cfg: { agents: {} } as never,
		runtime: { channel: {} } as never,
		client,
		agentId: "agent-1",
		logger: log,
	});
	return { dispatch, log, client };
}

describe("makeRuntimeDispatcher (SDK-1 dispatch seam)", () => {
	it("routes a DM through the direct-dm helper with a pointer body (no ciphertext)", async () => {
		dispatchSpy.mockReset();
		const { dispatch } = makeDispatcher();
		await dispatch(inbound(), new AbortController().signal);

		expect(dispatchSpy).toHaveBeenCalledTimes(1);
		const params = dispatchSpy.mock.calls[0]![0] as Record<string, unknown>;
		// SDK-1 regression guard: the original bug passed cfg:undefined + no runtime.
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
		// REQ-CTX-02: openclaw push-injects NO rine transcript (no double-context) —
		// the inbound carries only the pointer line, never role-tagged turns.
		expect(params.rawBody).not.toContain("[received]");
		expect(params.rawBody).not.toContain("[sent]");
		// TODO-4: the reply must target the SENDER, never this agent's own id.
		expect(params.rawBody).toContain("alice@lab");
		expect(params.rawBody).toMatch(/rine_reply/);
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

	// REQ-FSH-02: a one-way webhook self-send wakes the turn but must NOT auto-reply
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

	// x402 compat (D2): the three payment frames wake the agent to ACT (pay via the rine_pay
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

	// REQ-FSH-01: a catch-up/replayed frame wakes the agent to ACT but must not auto-reply.
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
});
