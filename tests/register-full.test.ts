import { describe, expect, it, vi } from "vitest";
import entry from "../index.js";

// E2E gateway contract: drives the REAL `defineChannelPluginEntry` registration-mode
// gating (from the installed openclaw SDK) with a spy api. Verified against a live
// 2026.6.1 gateway: `registerFull` wires the channel + 7 tools + notify service +
// expose route ONLY in "full" mode (gateway startup); "discovery" (what
// `plugins inspect --runtime` uses) registers only the channel. This guards the
// SDK-1-adjacent gap where registerFull's wiring was never unit-tested.

interface Calls {
	channel: string[];
	tool: string[];
	service: string[];
	route: string[];
}

function mockApi(mode: string): { api: unknown; calls: Calls } {
	const calls: Calls = { channel: [], tool: [], service: [], route: [] };
	const api = {
		id: "rine",
		name: "rine",
		registrationMode: mode,
		pluginConfig: {},
		config: {},
		runtime: { channel: {} },
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		registerChannel: (r: { plugin?: { id?: string }; id?: string }) =>
			calls.channel.push(r.plugin?.id ?? r.id ?? "ch"),
		registerTool: (t: { name?: string }) => calls.tool.push(t.name ?? "?"),
		registerService: (s: { id: string }) => calls.service.push(s.id),
		registerHttpRoute: (r: { path?: string }) => calls.route.push(r.path ?? "route"),
	};
	return { api, calls };
}

const register = (entry as unknown as { register: (api: unknown) => void }).register;

describe("plugin entry registration (live gateway contract)", () => {
	it("registers channel + all 7 tools + notify service + expose route in full mode (creds-tolerant)", () => {
		const { api, calls } = mockApi("full");
		// Must NOT throw on a fresh, un-onboarded install (no rine credentials).
		expect(() => register(api)).not.toThrow();
		expect(calls.channel.length).toBeGreaterThanOrEqual(1);
		expect(calls.tool).toEqual([
			"rine_whoami",
			"rine_discover",
			"rine_send",
			"rine_read",
			"rine_inbox",
			"rine_thread",
			"rine_onboard",
		]);
		expect(calls.service).toContain("rine-notify");
		expect(calls.route).toHaveLength(1);
	});

	it("registers ONLY the channel in discovery mode (registerFull gated off)", () => {
		const { api, calls } = mockApi("discovery");
		register(api);
		expect(calls.channel.length).toBeGreaterThanOrEqual(1);
		expect(calls.tool).toHaveLength(0);
		expect(calls.service).toHaveLength(0);
		expect(calls.route).toHaveLength(0);
	});
});
