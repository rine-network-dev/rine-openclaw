import { vi } from "vitest";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
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

/** The session the host runs a rine DM from `peerId` to agent `agentId` under: one per peer. */
export function sessionKeyFor(agentId: string, peerId: string): string {
	return `agent:${agentId}:rine:direct:${peerId}`;
}

/**
 * A runtime that resolves the route of a dispatched DM, which is all the dispatcher asks of
 * it. The dispatch helper itself is mocked in every suite that uses this, so nothing else is
 * ever reached.
 */
export function runtimeStub(): PluginRuntime {
	return {
		channel: {
			routing: {
				resolveAgentRoute: (p: { accountId: string; peer: { id: string } }) => ({
					sessionKey: sessionKeyFor(p.accountId, p.peer.id),
				}),
			},
		},
	} as never;
}

export { derivedAgentKeys } from "@rine-network/core/testing";
