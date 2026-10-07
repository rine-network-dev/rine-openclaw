import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { alreadySentText } from "../src/send-guard.js";
import { registerSendGuard } from "../src/send-guard-hook.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

function registered(): {
	names: string[];
	before_tool_call: Handler;
	after_tool_call: Handler;
	session_end: Handler;
} {
	const hooks = new Map<string, Handler>();
	const api = { on: (name: string, handler: Handler) => hooks.set(name, handler) };
	registerSendGuard(api as unknown as OpenClawPluginApi);
	const handler = (name: string): Handler => hooks.get(name) ?? (() => Promise.reject(new Error(name)));
	return {
		names: [...hooks.keys()].sort(),
		before_tool_call: handler("before_tool_call"),
		after_tool_call: handler("after_tool_call"),
		session_end: handler("session_end"),
	};
}

const sendEvent = (
	runId: string | undefined,
	params: Record<string, unknown>,
	toolCallId?: string,
	toolName = "rine_send",
) => ({
	toolName,
	params,
	runId,
	toolCallId,
});
const settled = (runId: string, toolCallId: string, error?: string) => ({
	toolName: "rine_send",
	params,
	runId,
	toolCallId,
	error,
});
const params = { to: "ops@mine.rine.network", payload: { text: "hi" } };
/** What the hook hands the host for an allowed call the model gave no idempotency key. */
const rewritten = { params: { idempotency_key: expect.stringMatching(/^rine-oc-/) } };

describe("send guard hook", () => {
	it("registers before_tool_call, after_tool_call and session_end", () => {
		expect(registered().names).toEqual(["after_tool_call", "before_tool_call", "session_end"]);
	});

	it("hands the host a block with the model-facing reason on an identical repeat in one run", () => {
		const { before_tool_call: hook } = registered();
		expect(hook(sendEvent("run-1", params), {})).toEqual(rewritten);
		expect(hook(sendEvent("run-1", params), {})).toEqual({
			block: true,
			blockReason: alreadySentText("ops@mine.rine.network"),
		});
	});

	it("does not block the same send in a later run", () => {
		const { before_tool_call: hook } = registered();
		hook(sendEvent("run-1", params), {});
		expect(hook(sendEvent("run-2", params), {})).toEqual(rewritten);
	});

	it("reads the run from the hook context when the event carries none", () => {
		const { before_tool_call: hook } = registered();
		hook(sendEvent(undefined, params), { runId: "run-1" });
		expect(hook(sendEvent(undefined, params), { runId: "run-1" })).toMatchObject({ block: true });
	});

	it("lets a call through when no run is known, since without a run there is no turn to bound it", () => {
		const { before_tool_call: hook } = registered();
		hook(sendEvent(undefined, params), {});
		expect(hook(sendEvent(undefined, params), {})).toBeUndefined();
	});

	it("lets a call through rather than throw, because the host blocks the tool when its hook throws", () => {
		const { before_tool_call: hook } = registered();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(hook(sendEvent("run-1", circular), {})).toBeUndefined();
	});

	it("lets the identical retry through when the host reports the first send failed", () => {
		const { before_tool_call: before, after_tool_call: after } = registered();
		before(sendEvent("run-1", params, "call-1"), {});
		after(settled("run-1", "call-1", "rine: rine_send failed: 429"), {});
		expect(before(sendEvent("run-1", params, "call-2"), {})).toEqual(rewritten);
	});

	it("keeps blocking the repeat once the host reports the first send succeeded", () => {
		const { before_tool_call: before, after_tool_call: after } = registered();
		before(sendEvent("run-1", params, "call-1"), {});
		after(settled("run-1", "call-1"), {});
		expect(before(sendEvent("run-1", params, "call-2"), {})).toMatchObject({ block: true });
	});

	it("keeps blocking a parallel duplicate while the first send is pending, and ignores the duplicate's own block result", () => {
		const { before_tool_call: before, after_tool_call: after } = registered();
		before(sendEvent("run-1", params, "call-1"), {});
		expect(before(sendEvent("run-1", params, "call-2"), {})).toMatchObject({ block: true });
		after(settled("run-1", "call-2", "blocked"), {});
		expect(before(sendEvent("run-1", params, "call-3"), {})).toMatchObject({ block: true });
	});

	it("reads the call and run of a settled call from the hook context when the event carries none", () => {
		const { before_tool_call: before, after_tool_call: after } = registered();
		before(sendEvent("run-1", params, "call-1"), {});
		after({ toolName: "rine_send", params, error: "boom" }, { runId: "run-1", toolCallId: "call-1" });
		expect(before(sendEvent("run-1", params, "call-2"), {})).toEqual(rewritten);
	});

	it("reads the call id of a guarded call from the hook context when the event carries none", () => {
		const { before_tool_call: before, after_tool_call: after } = registered();
		before(sendEvent("run-1", params), { toolCallId: "call-1" });
		after(settled("run-1", "call-1", "boom"), {});
		expect(before(sendEvent("run-1", params, "call-2"), {})).toEqual(rewritten);
	});

	it("leaves the model's own idempotency key alone", () => {
		const { before_tool_call: before } = registered();
		expect(before(sendEvent("run-1", { ...params, idempotency_key: "k-1" }, "call-1"), {})).toBeUndefined();
	});

	it("forgets a session's runs on session_end", () => {
		const { before_tool_call: hook, session_end: end } = registered();
		const ctx = { sessionKey: "agent:main:main" };
		hook(sendEvent("run-1", params), ctx);
		end({ sessionId: "s-1", sessionKey: "agent:main:main" }, {});
		expect(hook(sendEvent("run-1", params), ctx)).toEqual(rewritten);
	});
});

describe("send guard hook against a server that dedupes on the idempotency key", () => {
	/** The host's view of guarded sends in one run: the hook decides, the server delivers, the host settles. */
	function host() {
		const { before_tool_call: before, after_tool_call: after } = registered();
		const delivered = new Map<string, unknown>();
		let calls = 0;
		return {
			delivered,
			/** `outcome` is the error the host reports once the call ends; `reachServer` is whether the POST went out. */
			send(input: Record<string, unknown>, outcome?: string, reachServer = true, toolName = "rine_send") {
				const toolCallId = `call-${++calls}`;
				const verdict = before(sendEvent("run-1", input, toolCallId, toolName), {}) as
					| { block?: true; params?: Record<string, unknown> }
					| undefined;
				if (verdict?.block) return;
				const sent = { ...input, ...verdict?.params };
				// A send with no key is never deduped; a keyed one is delivered once per key.
				const dedupeKey = typeof sent.idempotency_key === "string" ? sent.idempotency_key : `call:${toolCallId}`;
				if (reachServer && !delivered.has(dedupeKey)) delivered.set(dedupeKey, sent);
				after(settled("run-1", toolCallId, outcome), {});
			},
		};
	}

	it("delivers once when a delivered send_and_wait reads as an error because its conversation status is failed", () => {
		const h = host();
		h.send(params, "rine_send_and_wait returned status failed", true, "rine_send_and_wait");
		h.send(params, undefined, true, "rine_send_and_wait");
		expect(h.delivered.size).toBe(1);
	});

	it("delivers once when the call throws after the POST went out, as a host timeout or a failed reply-open does", () => {
		const h = host();
		h.send(params, "rine: rine_send_and_wait failed: reply could not be opened", true, "rine_send_and_wait");
		h.send(params, "rine: rine_send_and_wait failed: aborted", true, "rine_send_and_wait");
		h.send(params, undefined, true, "rine_send_and_wait");
		expect(h.delivered.size).toBe(1);
	});

	it("still delivers the retry when the first attempt never reached the server", () => {
		const h = host();
		h.send(params, "rine: rine_send failed: ECONNREFUSED", false);
		h.send(params);
		expect(h.delivered.size).toBe(1);
	});

	it("delivers once when the model gives every retry a different idempotency key", () => {
		const h = host();
		h.send({ ...params, idempotency_key: "k-1" }, "rine: rine_send failed: timeout");
		h.send({ ...params, idempotency_key: "k-2" }, "rine: rine_send failed: timeout");
		h.send({ ...params, idempotency_key: "k-3" });
		expect(h.delivered.size).toBe(1);
	});
});
