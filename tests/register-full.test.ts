import { describe, expect, it } from "vitest";
import entry from "../index.js";
import { EXPOSED_TOOLS } from "../src/tools.js";
import { logger } from "./helpers.js";

// E2E gateway contract: drives the REAL `defineChannelPluginEntry` registration-mode
// gating (from the installed openclaw SDK) with a spy api. On the pinned host
// (openclaw 2026.9.1, `plugin-sdk/core.ts` register()): "full" (gateway startup) wires
// the channel + the exposed tool set + notify service + expose route; "discovery" (what
// `plugins inspect --runtime` uses) registers ONLY the channel; "tool-discovery" is the
// inverse — it calls registerFull WITHOUT registering the channel, so our registerFull
// has to survive being reached with no channel wired. This guards the gap where
// registerFull's wiring was never unit-tested.

interface Calls {
	channel: string[];
	tool: string[];
	service: string[];
	route: string[];
	hook: string[];
}

function mockApi(mode: string): { api: unknown; calls: Calls } {
	const calls: Calls = { channel: [], tool: [], service: [], route: [], hook: [] };
	const api = {
		id: "rine",
		name: "rine",
		registrationMode: mode,
		pluginConfig: {},
		config: {},
		runtime: { channel: {} },
		logger: logger(),
		registerChannel: (r: { plugin?: { id?: string }; id?: string }) =>
			calls.channel.push(r.plugin?.id ?? r.id ?? "ch"),
		registerTool: (t: { name?: string }) => calls.tool.push(t.name ?? "?"),
		registerService: (s: { id: string }) => calls.service.push(s.id),
		registerHttpRoute: (r: { path?: string }) => calls.route.push(r.path ?? "route"),
		on: (name: string) => calls.hook.push(name),
	};
	return { api, calls };
}

const register = (entry as unknown as { register: (api: unknown) => void }).register;

describe("plugin entry registration (live gateway contract)", () => {
	it("registers channel + the core tools + rine_pay + notify service + expose route in full mode (creds-tolerant)", () => {
		const { api, calls } = mockApi("full");
		// Must NOT throw on a fresh, un-onboarded install (no rine credentials).
		expect(() => register(api)).not.toThrow();
		expect(calls.channel.length).toBeGreaterThanOrEqual(1);
		// Registration walks EXPOSED_TOOLS in order. rine_fulfill (payee) is the one
		// lenient name — skipped when the linked mcp predates it — so it is the only tool
		// allowed to be absent; every other name, the group verbs included, is strict, and
		// a missing one throws a version-skew error before this assertion is reached.
		const expected = (EXPOSED_TOOLS as readonly string[]).filter(
			(n) => n !== "rine_fulfill" || calls.tool.includes(n),
		);
		expect(calls.tool).toEqual(expected);
		expect(calls.tool).toContain("rine_pay");
		expect(calls.tool).toContain("rine_group_vote");
		expect(calls.service).toContain("rine-notify");
		expect(calls.route).toHaveLength(1);
		expect([...calls.hook].sort()).toEqual([
			"after_tool_call",
			"after_tool_call",
			"before_tool_call",
			"llm_input",
			"llm_output",
			"session_end",
		]);
	});

	it("registers the channel and only the host hooks in discovery mode (registerFull gated off)", () => {
		const { api, calls } = mockApi("discovery");
		register(api);
		expect(calls.channel.length).toBeGreaterThanOrEqual(1);
		expect(calls.tool).toHaveLength(0);
		expect(calls.service).toHaveLength(0);
		expect(calls.route).toHaveLength(0);
		// The host builds its hook runner from this registry, so the send guard's three hooks, the
		// tool-answer `after_tool_call` and `llm_input`, and the silent-turn `llm_output` must all be here.
		expect([...calls.hook].sort()).toEqual(
			["after_tool_call", "after_tool_call", "before_tool_call", "llm_input", "llm_output", "session_end"],
		);
	});

	it("runs registerFull with NO channel registered in tool-discovery mode", () => {
		// 2026.9.1 added this mode and it is the one shape registerFull is entered
		// without a channel: the host wants the tool surface only. Nothing in our
		// registerFull may depend on registerChannel having run first.
		const { api, calls } = mockApi("tool-discovery");
		expect(() => register(api)).not.toThrow();
		expect(calls.channel).toHaveLength(0);
		expect(calls.tool).toContain("rine_send");
		expect(calls.service).toContain("rine-notify");
		expect(calls.route).toHaveLength(1);
	});
});
