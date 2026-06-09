import { describe, expect, it } from "vitest";
import { backoff, sleep } from "../src/transports/backoff.js";

describe("backoff", () => {
	it("is bounded to >=100ms and grows toward the cap", () => {
		for (let attempt = 0; attempt < 10; attempt++) {
			for (const r of [0, 0.5, 1]) {
				const d = backoff(attempt, 3000, 300_000, () => r);
				expect(d).toBeGreaterThanOrEqual(100);
				// capped at max + 30% jitter ceiling
				expect(d).toBeLessThanOrEqual(300_000 * 1.3 + 1);
			}
		}
	});

	it("respects reconnectMaxMs cap with zero jitter", () => {
		const d = backoff(20, 3000, 300_000, () => 0.5); // rand 0.5 => jitter 0
		expect(d).toBe(300_000);
	});

	it("base grows exponentially at low attempts", () => {
		const a0 = backoff(0, 3000, 300_000, () => 0.5);
		const a1 = backoff(1, 3000, 300_000, () => 0.5);
		expect(a0).toBe(3000);
		expect(a1).toBe(6000);
	});
});

describe("sleep", () => {
	it("rejects immediately when the signal is already aborted", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(sleep(10_000, ctrl.signal)).rejects.toThrow();
	});

	it("resolves after the delay", async () => {
		const start = Date.now();
		await sleep(20);
		expect(Date.now() - start).toBeGreaterThanOrEqual(15);
	});
});
