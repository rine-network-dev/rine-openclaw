import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "openclaw/plugin-sdk";

const runPollSpy = vi.fn(async (_tc: unknown) => {});
vi.mock("../src/transports/poll.js", () => ({
	runPollTransport: (tc: unknown) => runPollSpy(tc),
}));

// Cursor persistence is exercised directly in cursor.test.ts; here we stub it so the
// in-memory loop logic stays isolated (no fs) while still asserting the resume wiring.
const loadCursorMock = vi.fn((_dir: string, _agentId: string): string | undefined => undefined);
const saveCursorMock = vi.fn();
vi.mock("../src/transports/cursor.js", () => ({
	loadCursor: (dir: string, agentId: string) => loadCursorMock(dir, agentId),
	// Forward only the behavioral args (dir, agentId, eventId) — the optional logger is
	// best-effort plumbing and must not be pinned by tests.
	saveCursor: (dir: string, agentId: string, eventId: string) => saveCursorMock(dir, agentId, eventId),
}));

import { runSseTransport } from "../src/transports/sse.js";
import type { TransportContext } from "../src/transports/context.js";
import type { RineClient } from "../src/rine-client.js";
import type { RineConfig } from "../src/types.js";

function logger(): PluginLogger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function config(over: Partial<RineConfig> = {}): RineConfig {
	return {
		transport: "sse",
		pollIntervalMs: 5,
		reconnectBaseMs: 1,
		reconnectMaxMs: 5,
		a2aAcceptCleartext: true,
		allowFrom: ["*"],
		...over,
	};
}

/** A body that yields one SSE block then ends (clean close). */
function sseBody(block: string): { getReader: () => ReadableStreamDefaultReader<Uint8Array> } {
	let sent = false;
	return {
		getReader: () => ({
			read: async () => {
				if (sent) return { done: true, value: undefined };
				sent = true;
				return { done: false, value: new TextEncoder().encode(`${block}\n\n`) };
			},
			cancel: async () => {},
			releaseLock: () => {},
			closed: Promise.resolve(undefined),
		}) as unknown as ReadableStreamDefaultReader<Uint8Array>,
	};
}

function makeTc(over: Partial<RineConfig> = {}): { tc: TransportContext; ctrl: AbortController } {
	const ctrl = new AbortController();
	const client = {
		apiUrl: "https://rine.test",
		configDir: "/tmp/rine-test",
		getJwt: vi.fn(async () => "jwt"),
	} as unknown as RineClient;
	const tc: TransportContext = {
		client,
		config: config(over),
		agentId: "a1",
		logger: logger(),
		// Default: every message dispatches successfully (cursor may advance).
		onMessage: vi.fn(async () => true),
		signal: ctrl.signal,
	};
	return { tc, ctrl };
}

afterEach(() => {
	vi.restoreAllMocks();
	runPollSpy.mockReset();
	loadCursorMock.mockReset();
	loadCursorMock.mockReturnValue(undefined);
	saveCursorMock.mockReset();
});

describe("runSseTransport loop (SU-2)", () => {
	it("falls back to POLL after MAX_ATTEMPTS_BEFORE_FALLBACK consecutive stream errors", async () => {
		const fetchMock = vi.fn(async () => ({ ok: false, status: 503, body: null }));
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		await runSseTransport(tc);
		// 5 failed connects, then poll fallback.
		expect(fetchMock.mock.calls.length).toBe(5);
		expect(runPollSpy).toHaveBeenCalledTimes(1);
	});

	it("carries Last-Event-ID on the reconnect after an event with an id", async () => {
		let call = 0;
		const fetchMock = vi.fn(async () => {
			call += 1;
			if (call === 1) {
				return { ok: true, status: 200, body: sseBody("event: message\nid: e-9\ndata: {}") };
			}
			// second connect: capture headers, then fail enough to fall back fast.
			return { ok: false, status: 500, body: null };
		});
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		await runSseTransport(tc);
		const secondCall = fetchMock.mock.calls[1] as unknown as [string, { headers: Record<string, string> }];
		expect(secondCall[1].headers["Last-Event-ID"]).toBe("e-9");
	});

	it("does not send Last-Event-ID on the very first connect", async () => {
		const fetchMock = vi.fn(async () => ({ ok: false, status: 500, body: null }));
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		await runSseTransport(tc);
		const firstCall = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
		expect(firstCall[1].headers["Last-Event-ID"]).toBeUndefined();
	});

	it("carries a persisted Last-Event-ID on the very first connect (B1 restart resume)", async () => {
		loadCursorMock.mockReturnValue("m-persisted-7");
		const fetchMock = vi.fn(async () => ({ ok: false, status: 500, body: null }));
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		await runSseTransport(tc);
		const firstCall = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
		expect(firstCall[1].headers["Last-Event-ID"]).toBe("m-persisted-7");
		expect(loadCursorMock).toHaveBeenCalledWith("/tmp/rine-test", "a1");
	});

	it("persists the cursor for each delivered message frame's event id", async () => {
		let call = 0;
		const fetchMock = vi.fn(async () => {
			call += 1;
			if (call === 1) {
				return { ok: true, status: 200, body: sseBody("event: message\nid: e-9\ndata: {}") };
			}
			return { ok: false, status: 500, body: null };
		});
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		await runSseTransport(tc);
		expect(saveCursorMock).toHaveBeenCalledWith("/tmp/rine-test", "a1", "e-9");
	});

	it("does NOT advance the cursor when dispatch fails (preserves at-least-once retry)", async () => {
		let call = 0;
		const fetchMock = vi.fn(async () => {
			call += 1;
			if (call === 1) {
				return { ok: true, status: 200, body: sseBody("event: message\nid: m-fail\ndata: {}") };
			}
			return { ok: false, status: 500, body: null };
		});
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		tc.onMessage = vi.fn(async () => false); // dispatch failed
		await runSseTransport(tc);
		// Cursor never advanced past the undelivered message...
		expect(saveCursorMock).not.toHaveBeenCalled();
		// ...so the reconnect re-requests from before it (no Last-Event-ID past m-fail).
		const secondCall = fetchMock.mock.calls[1] as unknown as [string, { headers: Record<string, string> }];
		expect(secondCall[1].headers["Last-Event-ID"]).toBeUndefined();
	});

	it("does NOT advance the cursor past an id-bearing frame it cannot parse (defense-in-depth)", async () => {
		let call = 0;
		const fetchMock = vi.fn(async () => {
			call += 1;
			if (call === 1) {
				return { ok: true, status: 200, body: sseBody("event: message\nid: m-x\ndata: not-json") };
			}
			return { ok: false, status: 500, body: null };
		});
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		await runSseTransport(tc);
		expect(saveCursorMock).not.toHaveBeenCalled();
		const secondCall = fetchMock.mock.calls[1] as unknown as [string, { headers: Record<string, string> }];
		expect(secondCall[1].headers["Last-Event-ID"]).toBeUndefined();
	});
});
