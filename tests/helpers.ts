import { vi } from "vitest";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { resolveRineConfig } from "../src/config.js";
import type { RineConfig } from "../src/types.js";

/**
 * Test-only helpers shared by this package's suites.
 *
 * `logger()` is here because ten suites had each written the same four-method spy
 * object out for themselves. The duplication is not the whole cost: the fourth
 * method is the one a copy forgets, and a stub missing `debug` fails as a
 * `TypeError` raised inside the code under test — which reads as a product defect,
 * not as an incomplete fixture. One factory, so `PluginLogger`'s shape has one
 * home on this side of the suite too.
 *
 * A FACTORY and never a shared instance: each call returns fresh spies, so no two
 * tests can see each other's log calls.
 */
export function logger(): PluginLogger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * A resolved plugin config, with whatever this suite actually cares about
 * overridden.
 *
 * DERIVED from the real resolver, never typed out, for the same reason as
 * `logger()` and then some: seven suites had each written the whole default set
 * out by hand, so adding one required field to `RineConfig` broke all seven at
 * once. The compile error is the cheap half. The expensive half is silent — a
 * copy that keeps pinning a number the product has since moved goes on testing a
 * cadence nobody ships, and reads green while doing it. `config.ts` owns the
 * defaults and `config.test.ts` is what pins them; a fixture's business is only
 * the fields it overrides.
 *
 * 🔴 A suite that `vi.mock("../src/config.js")` reaches its own mock through
 * this helper, not the real resolver. Only `outbound-send.test.ts` mocks that
 * module today and it builds no config; a second one that does must build its
 * own fixture rather than reach for this.
 */
export function rineConfig(over: Partial<RineConfig> = {}): RineConfig {
	return { ...resolveRineConfig({}), ...over };
}
