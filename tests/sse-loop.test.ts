import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

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
		payments: { autoPay: false },
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

/** A body that yields each block as its own chunk, in order, then ends (clean close). */
function sseBodyBlocks(blocks: string[]): {
	getReader: () => ReadableStreamDefaultReader<Uint8Array>;
} {
	let i = 0;
	return {
		getReader: () =>
			({
				read: async () => {
					if (i >= blocks.length) return { done: true, value: undefined };
					const block = blocks[i++];
					return { done: false, value: new TextEncoder().encode(`${block}\n\n`) };
				},
				cancel: async () => {},
				releaseLock: () => {},
				closed: Promise.resolve(undefined),
			}) as unknown as ReadableStreamDefaultReader<Uint8Array>,
	};
}

/** A minimal MessageRead JSON for an SSE `event: message` frame with the given id. */
function msgData(id: string): string {
	return JSON.stringify({
		id,
		conversation_id: `c-${id}`,
		type: "rine.v1.dm",
		encrypted_payload: "X",
		encryption_version: "hpke-v1",
		sender_handle: "alice@lab",
	});
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

describe("runSseTransport loop", () => {
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

	// Catch-up (Phase-1) message frames arrive before the first heartbeat/status
	// frame — they must be dispatched as `replayed:true` (wake to act, no auto-reply). The
	// first heartbeat/status flips the stream to live; later message frames are `replayed:false`.
	it("tags pre-heartbeat frames as replayed (catch-up) and post-heartbeat frames as live", async () => {
		let call = 0;
		const fetchMock = vi.fn(async () => {
			call += 1;
			if (call === 1) {
				return {
					ok: true,
					status: 200,
					body: sseBodyBlocks([
						`event: message\nid: e-1\ndata: ${msgData("e-1")}`, // catch-up
						`event: message\nid: e-2\ndata: ${msgData("e-2")}`, // still catch-up
						"event: heartbeat\ndata: {}", // → live phase begins
						`event: message\nid: e-3\ndata: ${msgData("e-3")}`, // live
					]),
				};
			}
			return { ok: false, status: 500, body: null };
		});
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		const seen: Array<{ id: string; replayed: boolean | undefined }> = [];
		tc.onMessage = vi.fn(async (m: { id: string }, opts?: { replayed?: boolean }) => {
			seen.push({ id: m.id, replayed: opts?.replayed });
			return true;
		});
		await runSseTransport(tc);
		expect(seen).toEqual([
			{ id: "e-1", replayed: true },
			{ id: "e-2", replayed: true },
			{ id: "e-3", replayed: false },
		]);
	});

	it("flips to live on a status frame too (not only heartbeats)", async () => {
		let call = 0;
		const fetchMock = vi.fn(async () => {
			call += 1;
			if (call === 1) {
				return {
					ok: true,
					status: 200,
					body: sseBodyBlocks([
						'event: status\ndata: {"conversation_id":"c1","status":"read"}',
						`event: message\nid: e-9\ndata: ${msgData("e-9")}`,
					]),
				};
			}
			return { ok: false, status: 500, body: null };
		});
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		const seen: Array<{ id: string; replayed: boolean | undefined }> = [];
		tc.onMessage = vi.fn(async (m: { id: string }, opts?: { replayed?: boolean }) => {
			seen.push({ id: m.id, replayed: opts?.replayed });
			return true;
		});
		await runSseTransport(tc);
		expect(seen).toEqual([{ id: "e-9", replayed: false }]);
	});

	// Regression: a cursor-bearing connect (steady state after the first delivery /
	// any restart with a persisted cursor) resumes past the last DELIVERED message, so its
	// catch-up is bounded to genuinely-new undelivered messages. Those must auto-reply from the
	// first frame — WITHOUT waiting for a heartbeat the server does not emit at the boundary.
	// This guards the two failure modes the audit found: a busy `persistent=true` stream whose
	// queue never idles 30s (heartbeat never fires) and the first-DM-after-connect window.
	it("dispatches a cursor-bearing connect's frames as live (auto-reply) with no heartbeat", async () => {
		loadCursorMock.mockReturnValue("m-seed");
		let call = 0;
		const fetchMock = vi.fn(async () => {
			call += 1;
			if (call === 1) {
				return {
					ok: true,
					status: 200,
					body: sseBodyBlocks([
						`event: message\nid: e-1\ndata: ${msgData("e-1")}`,
						`event: message\nid: e-2\ndata: ${msgData("e-2")}`,
					]),
				};
			}
			return { ok: false, status: 500, body: null };
		});
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		const seen: Array<{ id: string; replayed: boolean | undefined }> = [];
		tc.onMessage = vi.fn(async (m: { id: string }, opts?: { replayed?: boolean }) => {
			seen.push({ id: m.id, replayed: opts?.replayed });
			return true;
		});
		await runSseTransport(tc);
		expect(seen).toEqual([
			{ id: "e-1", replayed: false },
			{ id: "e-2", replayed: false },
		]);
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
