import { describe, expect, it, vi } from "vitest";
import type { MessageRead } from "@rine-network/core";
import { streamConnectedLine } from "../src/constants.js";
import { runPollTransport } from "../src/transports/poll.js";
import type { TransportContext } from "../src/transports/context.js";
import type { RineClient } from "../src/rine-client.js";
import type { RineConfig } from "../src/types.js";
import { logger, rineConfig } from "./helpers.js";

function config(): RineConfig {
	return rineConfig({
		transport: "poll",
		pollIntervalMs: 5,
		reconnectBaseMs: 100,
		reconnectMaxMs: 1000,
	});
}

function msg(id: string): MessageRead {
	return {
		id,
		conversation_id: `c-${id}`,
		type: "rine.v1.dm",
		encrypted_payload: "X",
		encryption_version: "hpke-hybrid-v2",
		sender_handle: "alice@lab",
		created_at: "2026-06-09T00:00:00Z",
	};
}

describe("runPollTransport", () => {
	it("does no JWT mint / no /messages fetch when count is 0", async () => {
		const ctrl = new AbortController();
		const pollCount = vi.fn(async () => ({ kind: "count" as const, count: 0 }));
		const fetchNewMessages = vi.fn(async () => [] as MessageRead[]);
		const getJwt = vi.fn(async () => "jwt");
		const client = { pollCount, fetchNewMessages, getJwt } as unknown as RineClient;
		const onMessage = vi.fn(async () => true);
		const tc: TransportContext = {
			client,
			config: config(),
			agentId: "a1",
			logger: logger(),
			onMessage,
			signal: ctrl.signal,
			pollUrl: "https://rine.test/poll/tok",
		};
		const run = runPollTransport(tc);
		// let a couple of cycles run, then abort
		await new Promise((r) => setTimeout(r, 25));
		ctrl.abort();
		await run;
		expect(pollCount).toHaveBeenCalled();
		expect(getJwt).not.toHaveBeenCalled();
		expect(fetchNewMessages).not.toHaveBeenCalled();
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("fetches + dispatches when count > 0", async () => {
		const ctrl = new AbortController();
		let polled = 0;
		const pollCount = vi.fn(async () =>
			polled++ === 0
				? { kind: "count" as const, count: 2 }
				: { kind: "count" as const, count: 0 },
		);
		const fetchNewMessages = vi.fn(async () => [msg("m1"), msg("m2")]);
		const client = { pollCount, fetchNewMessages } as unknown as RineClient;
		const dispatched: string[] = [];
		const onMessage = vi.fn(async (m: { id: string }) => {
			dispatched.push(m.id);
			return true;
		});
		const tc: TransportContext = {
			client,
			config: config(),
			agentId: "a1",
			logger: logger(),
			onMessage,
			signal: ctrl.signal,
			pollUrl: "https://rine.test/poll/tok",
		};
		const run = runPollTransport(tc);
		await new Promise((r) => setTimeout(r, 25));
		ctrl.abort();
		await run;
		expect(fetchNewMessages).toHaveBeenCalledWith("a1");
		expect(dispatched).toEqual(["m1", "m2"]);
	});

	// A revoked/expired poll token (401/403) must not be masked as an empty inbox.
	it("logs an actionable error on a 401 auth failure and keeps the loop alive (never fetches)", async () => {
		const ctrl = new AbortController();
		const pollCount = vi.fn(async () => ({ kind: "auth-error" as const, status: 401 }));
		const fetchNewMessages = vi.fn(async () => [] as MessageRead[]);
		const getJwt = vi.fn(async () => "jwt");
		const client = { pollCount, fetchNewMessages, getJwt } as unknown as RineClient;
		const log = logger();
		const tc: TransportContext = {
			client,
			config: config(),
			agentId: "a1",
			logger: log,
			onMessage: vi.fn(async () => true),
			signal: ctrl.signal,
			pollUrl: "https://rine.test/poll/tok",
		};
		const run = runPollTransport(tc);
		await new Promise((r) => setTimeout(r, 25));
		ctrl.abort();
		await run;
		// Loop stayed alive (polled repeatedly), never minted a JWT / fetched.
		expect(pollCount.mock.calls.length).toBeGreaterThan(1);
		expect(getJwt).not.toHaveBeenCalled();
		expect(fetchNewMessages).not.toHaveBeenCalled();
		// Error is actionable — points at `rine poll-token`.
		const errs = (log.error as ReturnType<typeof vi.fn>).mock.calls;
		expect(errs.length).toBeGreaterThan(0);
		expect(String(errs[0]?.[0])).toContain("rine poll-token");
	});

	it("logs the auth error exactly once across repeated polls, and re-arms after a healthy poll", async () => {
		const ctrl = new AbortController();
		let polled = 0;
		// 401 for the first few polls, then a healthy count, then 401 again.
		const pollCount = vi.fn(async () => {
			polled += 1;
			if (polled <= 3) return { kind: "auth-error" as const, status: 401 };
			if (polled === 4) return { kind: "count" as const, count: 0 };
			return { kind: "auth-error" as const, status: 401 };
		});
		const client = { pollCount } as unknown as RineClient;
		const log = logger();
		const tc: TransportContext = {
			client,
			config: config(),
			agentId: "a1",
			logger: log,
			onMessage: vi.fn(async () => true),
			signal: ctrl.signal,
			pollUrl: "https://rine.test/poll/tok",
		};
		const run = runPollTransport(tc);
		await new Promise((r) => setTimeout(r, 60));
		ctrl.abort();
		await run;
		const authErrs = (log.error as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
			String(c[0]).includes("poll-token"),
		);
		// One log for the first streak, one more after the healthy poll re-armed it.
		expect(authErrs).toHaveLength(2);
	});

	it("warns (not errors) on a transient network error and keeps polling", async () => {
		const ctrl = new AbortController();
		const pollCount = vi.fn(async () => ({ kind: "error" as const }));
		const client = { pollCount } as unknown as RineClient;
		const log = logger();
		const tc: TransportContext = {
			client,
			config: config(),
			agentId: "a1",
			logger: log,
			onMessage: vi.fn(async () => true),
			signal: ctrl.signal,
			pollUrl: "https://rine.test/poll/tok",
		};
		const run = runPollTransport(tc);
		await new Promise((r) => setTimeout(r, 25));
		ctrl.abort();
		await run;
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("network"));
		expect(log.error).not.toHaveBeenCalled();
	});

	describe("stream-connected line", () => {
		async function infoLinesFor(result: { kind: string; count?: number; status?: number }): Promise<unknown[]> {
			const ctrl = new AbortController();
			const log = logger();
			const client = {
				pollCount: vi.fn(async () => result),
				fetchNewMessages: vi.fn(async () => [] as MessageRead[]),
			} as unknown as RineClient;
			const tc: TransportContext = {
				client,
				config: config(),
				agentId: "a1",
				logger: log,
				onMessage: vi.fn(async () => true),
				signal: ctrl.signal,
				pollUrl: "https://rine.test/poll/tok",
			};
			const run = runPollTransport(tc);
			await new Promise((r) => setTimeout(r, 40)); // several poll cycles
			ctrl.abort();
			await run;
			return (log.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		}

		it("is logged once, after the first healthy poll, however many polls follow", async () => {
			expect(await infoLinesFor({ kind: "count", count: 0 })).toEqual([streamConnectedLine("poll", "a1")]);
		});

		it("is logged before the first poll's messages are dispatched", async () => {
			const ctrl = new AbortController();
			const log = logger();
			const client = {
				pollCount: vi.fn(async () => ({ kind: "count" as const, count: 1 })),
				fetchNewMessages: vi.fn(async () => [msg("m-1")]),
			} as unknown as RineClient;
			const onMessage = vi.fn(() => new Promise<boolean>(() => {}));
			const tc: TransportContext = {
				client,
				config: config(),
				agentId: "a1",
				logger: log,
				onMessage,
				signal: ctrl.signal,
				pollUrl: "https://rine.test/poll/tok",
			};
			void runPollTransport(tc);
			await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
			expect((log.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
				streamConnectedLine("poll", "a1"),
			]);
			ctrl.abort();
		});

		it("is not logged while the poll token is rejected", async () => {
			expect(await infoLinesFor({ kind: "auth-error", status: 401 })).toEqual([]);
		});
	});

	it("logs and exits when poll_url is missing", async () => {
		const log = logger();
		const tc: TransportContext = {
			client: {} as unknown as RineClient,
			config: config(),
			agentId: "a1",
			logger: log,
			onMessage: vi.fn(),
			signal: new AbortController().signal,
			pollUrl: undefined,
		};
		await runPollTransport(tc);
		expect(log.error).toHaveBeenCalledWith(expect.stringContaining("poll_url"));
	});
});
