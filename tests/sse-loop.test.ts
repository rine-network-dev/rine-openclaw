import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/transports/poll.js", async () => (await import("./sse-helpers.js")).pollModuleMock);
vi.mock("../src/transports/cursor.js", async () => (await import("./sse-helpers.js")).cursorModuleMock);

import { runSseTransport } from "../src/transports/sse.js";
import {
	loadCursorMock,
	makeTc,
	msgData,
	resetSseMocks,
	runPollSpy,
	saveCursorMock,
	sseBody,
	sseBodyBlocks,
} from "./sse-helpers.js";

type Call = [string, { headers: Record<string, string> }];

afterEach(resetSseMocks);

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

	it("asks the server not to mark rows delivered when it streams them (peek)", async () => {
		const fetchMock = vi.fn(async () => ({ ok: false, status: 500, body: null }));
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		await runSseTransport(tc);
		const calls = fetchMock.mock.calls as unknown as Call[];
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) expect(call[1].headers["X-Rine-Peek"]).toBe("1");
	});

	it("keeps asking for peek on a connect that carries a cursor", async () => {
		loadCursorMock.mockReturnValue("m-persisted-7");
		const fetchMock = vi.fn(async () => ({ ok: false, status: 500, body: null }));
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		await runSseTransport(tc);
		const firstCall = fetchMock.mock.calls[0] as unknown as Call;
		expect(firstCall[1].headers["Last-Event-ID"]).toBe("m-persisted-7");
		expect(firstCall[1].headers["X-Rine-Peek"]).toBe("1");
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

	it("re-delivers a row whose dispatch failed on the next connect, without re-sending acked rows", async () => {
		// A server that honours the peek header (streaming marks nothing) and the cursor
		// (catch-up is strictly after it); only a successful dispatch marks a row delivered.
		const ids = ["m1", "m2"];
		const acked = new Set<string>();
		let connects = 0;
		const fetchMock = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
			connects += 1;
			if (connects > 2) return { ok: false, status: 500, body: null };
			const cursor = init.headers["Last-Event-ID"];
			const rows = ids.slice(cursor ? ids.indexOf(cursor) + 1 : 0).filter((id) => !acked.has(id));
			if (init.headers["X-Rine-Peek"] !== "1") for (const id of rows) acked.add(id); // marks at yield
			return {
				ok: true,
				status: 200,
				body: sseBodyBlocks(rows.map((id) => `event: message\nid: ${id}\ndata: ${msgData(id)}`)),
			};
		});
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		const dispatched: string[] = [];
		tc.onMessage = vi.fn(async (msg) => {
			const id = (msg as { id: string }).id;
			dispatched.push(id);
			if (id === "m1" && dispatched.filter((d) => d === "m1").length === 1) return false;
			acked.add(id);
			return true;
		});
		await runSseTransport(tc);
		// m2 succeeded behind the failed m1, yet the cursor never moved past the gap...
		const secondCall = fetchMock.mock.calls[1] as unknown as Call;
		expect(secondCall[1].headers["Last-Event-ID"]).toBeUndefined();
		// ...so m1 comes again (and only m1: m2 was acked).
		expect(dispatched).toEqual(["m1", "m2", "m1"]);
	});
});
