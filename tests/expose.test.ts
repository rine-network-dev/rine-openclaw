import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { verifyRineSignature } from "../src/transports/hmac.js";
import {
	handleInbound,
	resetExposeStateForTest,
	runExposeTransport,
} from "../src/transports/expose.js";
import type { TransportContext } from "../src/transports/context.js";
import type { RineClient } from "../src/rine-client.js";
import type { RineConfig } from "../src/types.js";
import { logger, rineConfig } from "./helpers.js";

function config(over: Partial<RineConfig> = {}): RineConfig {
	return rineConfig({
		transport: "expose",
		pollIntervalMs: 5,
		reconnectBaseMs: 100,
		reconnectMaxMs: 1000,
		...over,
	});
}

const SECRET = "shhh-secret";
function sign(body: string): string {
	return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

/** Minimal fake req/res for the route handler. */
function fakeReq(method: string, body: string, sig?: string) {
	const req = new EventEmitter() as unknown as import("node:http").IncomingMessage & {
		method: string;
		headers: Record<string, string | undefined>;
	};
	req.method = method;
	req.headers = { "x-rine-signature": sig };
	// async-iterable body
	(req as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> })[
		Symbol.asyncIterator
	] = async function* () {
		yield Buffer.from(body);
	};
	return req;
}
interface FakeRes {
	statusCode: number;
	ended: string;
	end(v?: string): void;
}
function fakeRes(): import("node:http").ServerResponse & FakeRes {
	const res: FakeRes = {
		statusCode: 0,
		ended: "",
		end(v?: string): void {
			res.ended = v ?? "";
		},
	};
	return res as unknown as import("node:http").ServerResponse & FakeRes;
}

describe("verifyRineSignature", () => {
	it("accepts a valid sha256= signature", () => {
		const body = '{"id":"m1"}';
		expect(verifyRineSignature(body, sign(body), SECRET)).toBe(true);
	});
	it("rejects a tampered body / wrong secret / missing header", () => {
		const body = '{"id":"m1"}';
		expect(verifyRineSignature('{"id":"x"}', sign(body), SECRET)).toBe(false);
		expect(verifyRineSignature(body, sign(body), "other")).toBe(false);
		expect(verifyRineSignature(body, undefined, SECRET)).toBe(false);
	});
});

describe("runExposeTransport fallback", () => {
	it("falls back to SSE when exposeBaseUrl is absent", async () => {
		resetExposeStateForTest();
		const ctrl = new AbortController();
		ctrl.abort(); // make the SSE loop exit immediately
		const log = logger();
		const tc: TransportContext = {
			client: {} as unknown as RineClient,
			config: config({ exposeBaseUrl: undefined }),
			agentId: "a1",
			logger: log,
			onMessage: vi.fn(),
			signal: ctrl.signal,
		};
		await runExposeTransport(tc);
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("falling back to SSE"));
	});

	it("falls back to SSE when webhook enrollment fails", async () => {
		resetExposeStateForTest();
		const ctrl = new AbortController();
		ctrl.abort();
		const log = logger();
		const post = vi.fn(async () => {
			throw new Error("ssrf_blocked");
		});
		const tc: TransportContext = {
			client: { client: { post } } as unknown as RineClient,
			config: config({ exposeBaseUrl: "https://gw.example.com" }),
			agentId: "a1",
			logger: log,
			onMessage: vi.fn(),
			signal: ctrl.signal,
		};
		await runExposeTransport(tc);
		expect(post).toHaveBeenCalled();
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("falling back to SSE"));
	});
});

describe("handleInbound (after enrollment)", () => {
	it("dispatches a standard webhook with a valid HMAC", async () => {
		const dispatched: string[] = [];
		// Re-enroll keeping state live by NOT aborting until after the post.
		resetExposeStateForTest();
		const ctrl = new AbortController();
		const post = vi.fn(async () => ({ secret: SECRET }));
		const onMessage = vi.fn(async (m: { id: string }) => {
			dispatched.push(m.id);
		});
		const tc: TransportContext = {
			client: { client: { post } } as unknown as RineClient,
			config: config({ exposeBaseUrl: "https://gw.example.com" }),
			agentId: "a1",
			logger: logger(),
			onMessage: onMessage as unknown as TransportContext["onMessage"],
			signal: ctrl.signal,
		};
		void runExposeTransport(tc);
		await new Promise((r) => setTimeout(r, 5));

		const body = JSON.stringify({ message: { id: "m1", conversation_id: "c1", type: "rine.v1.dm", encrypted_payload: "X", encryption_version: "hpke-v1", sender_handle: "a@b" } });
		const req = fakeReq("POST", body, sign(body));
		const res = fakeRes();
		const handled = await handleInbound(req, res);
		ctrl.abort();
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(dispatched).toEqual(["m1"]);
	});

	it("rejects an invalid HMAC (no dispatch)", async () => {
		resetExposeStateForTest();
		const ctrl = new AbortController();
		const post = vi.fn(async () => ({ secret: SECRET }));
		const onMessage = vi.fn(async () => {});
		const tc: TransportContext = {
			client: { client: { post } } as unknown as RineClient,
			config: config({ exposeBaseUrl: "https://gw.example.com" }),
			agentId: "a1",
			logger: logger(),
			onMessage: onMessage as unknown as TransportContext["onMessage"],
			signal: ctrl.signal,
		};
		void runExposeTransport(tc);
		await new Promise((r) => setTimeout(r, 5));

		const body = JSON.stringify({ message: { id: "m1" } });
		const req = fakeReq("POST", body, "sha256=deadbeef");
		const res = fakeRes();
		await handleInbound(req, res);
		ctrl.abort();
		expect(res.statusCode).toBe(401);
		expect(onMessage).not.toHaveBeenCalled();
	});
});

describe("handleInbound size cap + cleartext policy", () => {
	async function startExpose(over: Partial<RineConfig>, onMessage: ReturnType<typeof vi.fn>) {
		resetExposeStateForTest();
		const ctrl = new AbortController();
		const post = vi.fn(async () => ({ secret: SECRET, id: "wh-1" }));
		const tc: TransportContext = {
			client: { client: { post, delete: vi.fn() } } as unknown as RineClient,
			config: config({ exposeBaseUrl: "https://gw.example.com", ...over }),
			agentId: "a1",
			logger: logger(),
			onMessage: onMessage as unknown as TransportContext["onMessage"],
			signal: ctrl.signal,
		};
		void runExposeTransport(tc);
		await new Promise((r) => setTimeout(r, 5));
		return ctrl;
	}

	it("rejects a body over the 512KB cap with 413 before HMAC", async () => {
		const onMessage = vi.fn(async () => {});
		const ctrl = await startExpose({}, onMessage);
		// 600KB body, signed correctly — must still be rejected by size, not reach dispatch.
		const big = "x".repeat(600 * 1024);
		const req = fakeReq("POST", big, sign(big));
		const res = fakeRes();
		await handleInbound(req, res);
		ctrl.abort();
		expect(res.statusCode).toBe(413);
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("drops cleartext A2A inbound when a2aAcceptCleartext is false", async () => {
		const onMessage = vi.fn(async () => {});
		const ctrl = await startExpose({ a2aAcceptCleartext: false }, onMessage);
		const body = JSON.stringify({
			result: {
				artifactUpdate: {
					taskId: "task-1",
					from: "bob@org",
					artifact: { encrypted_payload: "" },
				},
			},
		});
		const req = fakeReq("POST", body, sign(body));
		const res = fakeRes();
		await handleInbound(req, res);
		ctrl.abort();
		expect(res.statusCode).toBe(202);
		expect(res.ended).toContain("cleartext");
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("dispatches cleartext A2A inbound when a2aAcceptCleartext is true", async () => {
		const onMessage = vi.fn(async () => {});
		const ctrl = await startExpose({ a2aAcceptCleartext: true }, onMessage);
		const body = JSON.stringify({
			result: {
				artifactUpdate: {
					taskId: "task-2",
					from: "bob@org",
					artifact: { encrypted_payload: "" },
				},
			},
		});
		const req = fakeReq("POST", body, sign(body));
		const res = fakeRes();
		await handleInbound(req, res);
		ctrl.abort();
		expect(res.statusCode).toBe(200);
		expect(onMessage).toHaveBeenCalled();
	});
});

describe("runExposeTransport webhook cleanup", () => {
	it("DELETEs the enrolled webhook on abort/teardown", async () => {
		resetExposeStateForTest();
		const ctrl = new AbortController();
		const post = vi.fn(async () => ({ secret: SECRET, id: "wh-42" }));
		const del = vi.fn(async () => ({}));
		const tc: TransportContext = {
			client: { client: { post, delete: del } } as unknown as RineClient,
			config: config({ exposeBaseUrl: "https://gw.example.com" }),
			agentId: "a1",
			logger: logger(),
			onMessage: vi.fn() as unknown as TransportContext["onMessage"],
			signal: ctrl.signal,
		};
		const run = runExposeTransport(tc);
		await new Promise((r) => setTimeout(r, 5));
		ctrl.abort();
		await run;
		expect(del).toHaveBeenCalledWith("/webhooks/wh-42");
	});

	it("does not DELETE when the create response carried no id", async () => {
		resetExposeStateForTest();
		const ctrl = new AbortController();
		const post = vi.fn(async () => ({ secret: SECRET }));
		const del = vi.fn(async () => ({}));
		const tc: TransportContext = {
			client: { client: { post, delete: del } } as unknown as RineClient,
			config: config({ exposeBaseUrl: "https://gw.example.com" }),
			agentId: "a1",
			logger: logger(),
			onMessage: vi.fn() as unknown as TransportContext["onMessage"],
			signal: ctrl.signal,
		};
		const run = runExposeTransport(tc);
		await new Promise((r) => setTimeout(r, 5));
		ctrl.abort();
		await run;
		expect(del).not.toHaveBeenCalled();
	});
});
