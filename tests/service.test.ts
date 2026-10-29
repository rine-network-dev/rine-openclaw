import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RineClient } from "../src/rine-client.js";
import { makeRineService, resolveBoundAgentId } from "../src/service.js";
import type { RineConfig } from "../src/types.js";
import { logger, rineConfig } from "./helpers.js";
import { type TestDirs, freshDirs, seedRuntime } from "./identity.js";

// Regression guard for the notify-service agent-id bug: the service used to bind the
// transport to the token's subject (an `org:` principal string), which is NOT an agent id —
// every `/agents/{subject}/stream|messages` request 404'd. The fix resolves the real agent
// id via the API (`fetchAgents` + core `resolveAgent`), honoring an explicit `agentId` override.

// Every value this suite used to type out was already the shipped default, so it
// overrides nothing by default — the whole fixture is the overrides a test asks for.
function config(over: Partial<RineConfig> = {}): RineConfig {
	return rineConfig(over);
}

/** A RineClient whose underlying HttpClient.get returns a canned `/agents` payload. */
function clientWithAgents(
	get: (path: string) => Promise<unknown>,
): RineClient {
	return {
		apiUrl: "https://rine.test",
		client: { get: vi.fn(get) },
	} as unknown as RineClient;
}

// token subject vs agent_id — deliberately different UUIDs, mirroring a real install.
const CLIENT_ID = "a3f045a9-4e96-4fc5-9037-c4f26d65ebeb";
const AGENT_ID = "622684e9-8ef3-4633-b407-b658c23c6b1f";

/**
 * Drive the real service against a temp config dir. `baseUrl` points at a stubbed fetch
 * that always fails, so the run stops at agent resolution — far enough to prove the
 * credential gate opened, with no network and no transport.
 */
function serviceApi(
	configDir: string,
	log: PluginLogger,
	over: Record<string, unknown> = {},
): OpenClawPluginApi {
	return {
		config: {
			channels: {
				rine: { configDir, baseUrl: "https://rine.test", pollIntervalMs: 20, ...over },
			},
		},
		runtime: { channel: {} },
		logger: log,
	} as unknown as OpenClawPluginApi;
}

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for service state");
		await new Promise((r) => setTimeout(r, 10));
	}
}

const startedLog = (log: PluginLogger): boolean =>
	vi.mocked(log.info).mock.calls.some(([m]) => String(m).includes("identity found"));

describe("makeRineService credential pickup", () => {
	let dirs: TestDirs;

	beforeEach(() => {
		dirs = freshDirs();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		dirs.dispose();
	});

	it("idles with one actionable warning when the install has no credentials", async () => {
		const log = logger();
		const service = makeRineService(serviceApi(dirs.configDir, log));
		expect(() => service.start({ logger: log } as never)).not.toThrow();

		await until(() => vi.mocked(log.warn).mock.calls.length > 0);
		expect(String(vi.mocked(log.warn).mock.calls[0]?.[0])).toContain("notify service idle");
		await new Promise((r) => setTimeout(r, 120));
		// The wait must not re-log per attempt, and must not start the transport.
		expect(log.warn).toHaveBeenCalledOnce();
		expect(startedLog(log)).toBe(false);
		service.stop?.({ logger: log } as never);
	});

	it("starts once credentials appear, without a gateway restart", async () => {
		const log = logger();
		const service = makeRineService(serviceApi(dirs.configDir, log));
		service.start({ logger: log } as never);
		await until(() => vi.mocked(log.warn).mock.calls.length > 0);

		seedRuntime(dirs);
		await until(() => startedLog(log));
		expect(vi.mocked(log.info).mock.calls.filter(([m]) => String(m).includes("identity found"))).toHaveLength(1);
		service.stop?.({ logger: log } as never);
	});

	it("waits for poll_url before starting the POLL transport", async () => {
		const log = logger();
		const service = makeRineService(serviceApi(dirs.configDir, log, { transport: "poll" }));
		service.start({ logger: log } as never);
		await until(() => vi.mocked(log.warn).mock.calls.length > 0);

		// Onboarding writes the identity first and poll_url seconds later. Starting on the
		// identity alone freezes an undefined poll_url into the transport, and the poll loop
		// exits for good — the inbox would stay dead until the gateway restarts.
		seedRuntime(dirs);
		await new Promise((r) => setTimeout(r, 120));
		expect(startedLog(log)).toBe(false);

		seedRuntime(dirs, "https://rine.test/poll/tok");
		await until(() => startedLog(log));
		service.stop?.({ logger: log } as never);
	});

	it("stop() cancels a pending credential wait", async () => {
		const log = logger();
		const service = makeRineService(serviceApi(dirs.configDir, log));
		service.start({ logger: log } as never);
		await until(() => vi.mocked(log.warn).mock.calls.length > 0);

		service.stop?.({ logger: log } as never);
		seedRuntime(dirs);
		await new Promise((r) => setTimeout(r, 150));
		expect(startedLog(log)).toBe(false);
		expect(log.error).not.toHaveBeenCalled();
	});
});

describe("resolveBoundAgentId", () => {
	// The environment is a rung of the same ladder, so every case below says
	// explicitly whether it is occupied rather than inheriting the host's.
	beforeEach(() => {
		vi.stubEnv("RINE_AGENT", "");
	});

	it("binds the agent RINE_AGENT names when the operator configured none", async () => {
		vi.stubEnv("RINE_AGENT", "scout");
		const client = clientWithAgents(async () => ({
			items: [
				{ id: AGENT_ID, name: "maggs", handle: "maggs@x" },
				{ id: "other-id", name: "scout", handle: "scout@x" },
			],
		}));

		const id = await resolveBoundAgentId(client, config(), logger());

		expect(id).toBe("other-id");
	});

	it("takes channels.rine.agentId over RINE_AGENT — precedence, not a disagreement", async () => {
		vi.stubEnv("RINE_AGENT", "scout");
		const log = logger();
		const client = clientWithAgents(async () => ({
			items: [
				{ id: AGENT_ID, name: "maggs", handle: "maggs@x" },
				{ id: "other-id", name: "scout", handle: "scout@x" },
			],
		}));

		const id = await resolveBoundAgentId(client, config({ agentId: "maggs" }), log);

		expect(id).toBe(AGENT_ID);
		expect(log.error).not.toHaveBeenCalled();
	});

	it("resolves the org's sole agent id from /agents (never the token subject)", async () => {
		const client = clientWithAgents(async () => ({
			items: [{ id: AGENT_ID, name: "maggs", handle: "maggs@janitoresses" }],
		}));
		const id = await resolveBoundAgentId(client, config(), logger());
		expect(id).toBe(AGENT_ID);
		expect(id).not.toBe(CLIENT_ID);
	});

	it("honors an explicit agentId UUID override in a multi-agent org", async () => {
		const other = "11111111-1111-1111-1111-111111111111";
		const client = clientWithAgents(async () => ({
			items: [
				{ id: AGENT_ID, name: "maggs", handle: "maggs@x" },
				{ id: other, name: "scout", handle: "scout@x" },
			],
		}));
		const id = await resolveBoundAgentId(client, config({ agentId: other }), logger());
		expect(id).toBe(other);
	});

	it("resolves a bare-name agentId override against the agent list", async () => {
		const client = clientWithAgents(async () => ({
			items: [
				{ id: AGENT_ID, name: "maggs", handle: "maggs@x" },
				{ id: "other-id", name: "scout", handle: "scout@x" },
			],
		}));
		const id = await resolveBoundAgentId(client, config({ agentId: "maggs" }), logger());
		expect(id).toBe(AGENT_ID);
	});

	it("resolves a handle agentId override against the agent list, not WebFinger", async () => {
		// `channels.rine.agentId` is documented as "a name, a handle, or a
		// UUID", and the handle spelling used to leave the org entirely: it
		// went to WebFinger, which answers who owns a handle anywhere. An
		// install configured with a handle it does not own would then bind its
		// notify transport to a foreign agent id and 404 on every read.
		const client = clientWithAgents(async (path) => {
			if (path !== "/agents") throw new Error(`unexpected path ${path}`);
			return {
				items: [
					{ id: AGENT_ID, name: "maggs", handle: "maggs@x.rine.network" },
					{ id: "other-id", name: "scout", handle: "scout@x.rine.network" },
				],
			};
		});
		const id = await resolveBoundAgentId(
			client,
			config({ agentId: "scout@x.rine.network" }),
			logger(),
		);
		expect(id).toBe("other-id");
	});

	it("idles (undefined) + logs when the configured handle is nobody here", async () => {
		const log = logger();
		const client = clientWithAgents(async () => ({
			items: [
				{ id: AGENT_ID, name: "maggs", handle: "maggs@x.rine.network" },
				{ id: "other-id", name: "scout", handle: "scout@x.rine.network" },
			],
		}));
		const id = await resolveBoundAgentId(
			client,
			config({ agentId: "ghost@other-org.rine.network" }),
			log,
		);
		expect(id).toBeUndefined();
		expect(log.error).toHaveBeenCalledOnce();
		expect(vi.mocked(log.error).mock.calls[0]?.[0]).toContain(
			"No agent with handle 'ghost@other-org.rine.network'",
		);
	});

	it("idles (undefined) + logs an error on a network failure", async () => {
		const log = logger();
		const client = clientWithAgents(async () => {
			throw new Error("ECONNREFUSED");
		});
		const id = await resolveBoundAgentId(client, config(), log);
		expect(id).toBeUndefined();
		expect(log.error).toHaveBeenCalledOnce();
	});

	it("idles (undefined) + logs on an ambiguous multi-agent org with no agentId set", async () => {
		const log = logger();
		const client = clientWithAgents(async () => ({
			items: [
				{ id: AGENT_ID, name: "maggs", handle: "maggs@x" },
				{ id: "other-id", name: "scout", handle: "scout@x" },
			],
		}));
		const id = await resolveBoundAgentId(client, config(), log);
		expect(id).toBeUndefined();
		expect(log.error).toHaveBeenCalledOnce();
	});
});
