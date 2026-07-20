import type { PluginLogger } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { RineClient } from "../src/rine-client.js";
import { resolveBoundAgentId } from "../src/service.js";
import type { RineConfig } from "../src/types.js";

// Regression guard for the notify-service agent-id bug: the service used to bind the
// transport to `credentials.json.client_id` (the OAuth client id), which is NOT an agent id —
// every `/agents/{client_id}/stream|messages` request 404'd. The fix resolves the real agent
// id via the API (`fetchAgents` + core `resolveAgent`), honoring an explicit `agentId` override.

function logger(): PluginLogger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function config(over: Partial<RineConfig> = {}): RineConfig {
	return {
		transport: "sse",
		pollIntervalMs: 60_000,
		reconnectBaseMs: 3_000,
		reconnectMaxMs: 300_000,
		a2aAcceptCleartext: true,
		payments: { autoPay: false },
		allowFrom: ["*"],
		...over,
	};
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

// client_id (OAuth) vs agent_id — deliberately different UUIDs, mirroring real credentials.
const CLIENT_ID = "a3f045a9-4e96-4fc5-9037-c4f26d65ebeb";
const AGENT_ID = "622684e9-8ef3-4633-b407-b658c23c6b1f";

describe("resolveBoundAgentId", () => {
	it("resolves the org's sole agent id from /agents (never the OAuth client_id)", async () => {
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
