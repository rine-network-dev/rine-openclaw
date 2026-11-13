import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollCount } from "../src/poll-count.js";
import type { RineClient } from "../src/rine-client.js";
import type { TransportContext } from "../src/transports/context.js";
import { runPollTransport } from "../src/transports/poll.js";
import { RESUMED_LINE, SUSPENDED_LINE, SUSPENDED_RETRY_MS } from "../src/transports/suspended.js";
import { logger, rineConfig } from "./helpers.js";

const URL_ = "https://rine.test/poll/tok";
const answer = (status: number, body?: unknown) => ({
	ok: status < 400,
	status,
	json: async () => {
		if (body === undefined) throw new SyntaxError("not json");
		return body;
	},
});

describe("pollCount", () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		["agent_suspended"],
		["branch_suspended"],
		["org_frozen"],
	])("test_pollcount_when_the_poll_answers_403_%s_then_held", async (hold) => {
		vi.stubGlobal("fetch", vi.fn(async () => answer(403, { error: hold })));
		expect(await pollCount(URL_)).toEqual({ kind: "held", hold });
	});

	it.each([
		[403, { error: "forbidden" }],
		[403, undefined],
		[401, { error: "agent_suspended" }],
	])("test_pollcount_when_the_poll_answers_%s_without_a_hold_then_auth_error", async (status, body) => {
		vi.stubGlobal("fetch", vi.fn(async () => answer(status, body)));
		expect(await pollCount(URL_)).toEqual({ kind: "auth-error", status });
	});
});

describe("runPollTransport through a suspension", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("test_poll_when_the_agent_is_held_then_it_keeps_polling_every_interval_and_recovers", async () => {
		const ctrl = new AbortController();
		let held = true;
		const pollCountFn = vi.fn(async () =>
			held ? { kind: "held" as const, hold: "agent_suspended" as const } : { kind: "count" as const, count: 0 },
		);
		const log = logger();
		const tc: TransportContext = {
			client: { pollCount: pollCountFn } as unknown as RineClient,
			config: rineConfig({ transport: "poll", pollIntervalMs: 5 }),
			agentId: "a1",
			logger: log,
			onMessage: vi.fn(async () => true),
			signal: ctrl.signal,
			pollUrl: URL_,
		};
		const run = runPollTransport(tc);
		await vi.advanceTimersByTimeAsync(SUSPENDED_RETRY_MS * 20);
		expect(pollCountFn.mock.calls.length).toBeGreaterThanOrEqual(20);
		expect(pollCountFn.mock.calls.length).toBeLessThanOrEqual(22);
		expect((log.error as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
		expect((log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([SUSPENDED_LINE]);
		held = false;
		await vi.advanceTimersByTimeAsync(SUSPENDED_RETRY_MS);
		expect((log.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toContain(RESUMED_LINE);
		ctrl.abort();
		await vi.advanceTimersByTimeAsync(0);
		await run;
	});
});
