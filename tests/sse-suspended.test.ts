import { RineApiError } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/transports/poll.js", async () => (await import("./sse-helpers.js")).pollModuleMock);
vi.mock("../src/transports/cursor.js", async () => (await import("./sse-helpers.js")).cursorModuleMock);

import { RESUMED_LINE, SUSPENDED_LINE, SUSPENDED_RETRY_MS } from "../src/transports/suspended.js";
import { runSseTransport } from "../src/transports/sse.js";
import { makeTc, resetSseMocks, runPollSpy } from "./sse-helpers.js";

/** The token mint's refusal of a held agent: a 400 `unauthorized_client` carrying the hold in `reason`. */
const mintRefusal = (reason = "agent_suspended") =>
	new RineApiError(400, "held", undefined, "unauthorized_client", {
		error: "unauthorized_client",
		reason,
	});

const refusedStream = (status: number, body: unknown) => ({
	ok: false,
	status,
	body: null,
	json: async () => body,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	resetSseMocks();
});

const warns = (tc: ReturnType<typeof makeTc>["tc"]) =>
	(tc.logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
const infos = (tc: ReturnType<typeof makeTc>["tc"]) =>
	(tc.logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

describe("runSseTransport through a suspension", () => {
	it("test_sse_when_the_mint_refuses_a_hold_twenty_times_then_it_never_falls_back_to_poll", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { tc, ctrl } = makeTc();
		(tc.client.getJwt as ReturnType<typeof vi.fn>).mockRejectedValue(mintRefusal());
		const run = runSseTransport(tc);
		await vi.advanceTimersByTimeAsync(SUSPENDED_RETRY_MS * 20);
		const mints = (tc.client.getJwt as ReturnType<typeof vi.fn>).mock.calls.length;
		// one ask per 30 s wait: a transport that did not wait would ask thousands of times
		expect(mints).toBeGreaterThanOrEqual(20);
		expect(mints).toBeLessThanOrEqual(22);
		ctrl.abort();
		await run;
		expect(runPollSpy).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(warns(tc).filter((l) => l === SUSPENDED_LINE)).toHaveLength(1);
		expect(warns(tc).filter((l) => String(l).includes("SSE stream error"))).toEqual([]);
	});

	it.each([
		["agent_suspended"],
		["branch_suspended"],
		["org_frozen"],
	])("test_sse_when_the_stream_answers_403_%s_then_it_waits_and_never_falls_back", async (code) => {
		const fetchMock = vi.fn(async () => refusedStream(403, { error: code }));
		vi.stubGlobal("fetch", fetchMock);
		const { tc, ctrl } = makeTc();
		const run = runSseTransport(tc);
		await vi.advanceTimersByTimeAsync(SUSPENDED_RETRY_MS * 20);
		ctrl.abort();
		await run;
		expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(20);
		expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(22);
		expect(runPollSpy).not.toHaveBeenCalled();
	});

	it("test_sse_when_the_hold_lifts_then_it_reconnects_within_one_interval_and_logs_both_lines", async () => {
		let held = true;
		const { tc, ctrl } = makeTc();
		// a clean, silent stream that stays open until the test aborts
		const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: openBody(ctrl.signal) }));
		vi.stubGlobal("fetch", fetchMock);
		(tc.client.getJwt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			if (held) throw mintRefusal();
			return "jwt";
		});
		const run = runSseTransport(tc);
		await vi.advanceTimersByTimeAsync(SUSPENDED_RETRY_MS * 3);
		expect(fetchMock).not.toHaveBeenCalled();
		held = false;
		await vi.advanceTimersByTimeAsync(SUSPENDED_RETRY_MS);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(warns(tc).filter((l) => l === SUSPENDED_LINE)).toHaveLength(1);
		expect(infos(tc).filter((l) => l === RESUMED_LINE)).toHaveLength(1);
		ctrl.abort();
		await vi.advanceTimersByTimeAsync(0);
		await run;
		expect(runPollSpy).not.toHaveBeenCalled();
	});

	it("test_sse_when_a_connect_without_a_hold_succeeds_then_no_resumed_line_is_logged", async () => {
		const { tc, ctrl } = makeTc();
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body: openBody(ctrl.signal) })));
		const run = runSseTransport(tc);
		await vi.advanceTimersByTimeAsync(10);
		ctrl.abort();
		await vi.advanceTimersByTimeAsync(10);
		await run;
		expect(infos(tc)).not.toContain(RESUMED_LINE);
	});

	it("test_sse_when_the_403_names_no_hold_then_it_still_falls_back_after_five", async () => {
		const fetchMock = vi.fn(async () => refusedStream(403, { error: "forbidden" }));
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		const run = runSseTransport(tc);
		await vi.advanceTimersByTimeAsync(1000);
		await run;
		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(runPollSpy).toHaveBeenCalledTimes(1);
	});

	it("test_sse_when_the_stream_answers_401_then_the_next_connect_mints_a_fresh_token", async () => {
		let call = 0;
		const fetchMock = vi.fn(async () => {
			call += 1;
			return call === 1 ? refusedStream(401, { detail: "expired" }) : { ok: false, status: 500, body: null };
		});
		vi.stubGlobal("fetch", fetchMock);
		const { tc } = makeTc();
		const run = runSseTransport(tc);
		await vi.advanceTimersByTimeAsync(1000);
		await run;
		const forced = (tc.client.getJwt as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(forced[0]).toBeUndefined();
		expect(forced[1]).toBe(true);
	});
});

/** A stream that stays open and silent until `signal` aborts. */
function openBody(signal: AbortSignal) {
	return {
		getReader: () =>
			({
				read: () =>
					new Promise((_, reject) => {
						signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
					}),
				cancel: async () => {},
				releaseLock: () => {},
				closed: Promise.resolve(undefined),
			}) as unknown as ReadableStreamDefaultReader<Uint8Array>,
	};
}
