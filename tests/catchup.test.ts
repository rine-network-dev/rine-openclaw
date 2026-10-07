import { describe, expect, it } from "vitest";
import { FRESH_CATCHUP_WINDOW_MS, isFreshCatchup } from "../src/transports/catchup.js";

const now = Date.parse("2026-09-29T12:00:00Z");
const at = (offsetMs: number): string => new Date(now + offsetMs).toISOString();

describe("isFreshCatchup", () => {
	it("is fresh for a recent stamp", () => {
		expect(isFreshCatchup(at(-30_000), now)).toBe(true);
	});

	it("is fresh exactly at the window boundary and stale one millisecond past it", () => {
		expect(isFreshCatchup(at(-FRESH_CATCHUP_WINDOW_MS), now)).toBe(true);
		expect(isFreshCatchup(at(-FRESH_CATCHUP_WINDOW_MS - 1), now)).toBe(false);
	});

	it("is fresh for a stamp in the future, which is clock skew and not age", () => {
		expect(isFreshCatchup(at(5 * 60_000), now)).toBe(true);
	});

	it("is stale when the stamp is missing", () => {
		expect(isFreshCatchup(undefined, now)).toBe(false);
	});

	it("is stale when the stamp cannot be parsed", () => {
		expect(isFreshCatchup("garbage", now)).toBe(false);
		expect(isFreshCatchup("", now)).toBe(false);
	});
});
