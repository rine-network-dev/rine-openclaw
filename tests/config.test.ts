import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	readRineIdentity,
	resolveRineConfig,
	resolveRineConfigFromCfg,
} from "../src/config.js";
import { SETASIDE_SWEEP_INTERVAL_MS } from "../src/constants.js";
import { seedOrgIdentity } from "@rine-network/core/testing";
import { TEST_AGENT, type TestDirs, freshDirs, seedRuntime } from "./identity.js";

describe("resolveRineConfig", () => {
	it("applies defaults on an empty config", () => {
		const c = resolveRineConfig({});
		expect(c.transport).toBe("sse");
		expect(c.pollIntervalMs).toBe(60_000);
		expect(c.reconnectBaseMs).toBe(3_000);
		expect(c.reconnectMaxMs).toBe(300_000);
		expect(c.setasideSweepIntervalMs).toBe(SETASIDE_SWEEP_INTERVAL_MS);
		expect(c.a2aAcceptCleartext).toBe(true);
		expect(c.allowFrom).toEqual(["*"]);
		expect(c.payments).toEqual({ autoPay: false }); // auto-pay OFF by default
	});

	it("enables auto-pay only on an explicit boolean true (opt-in)", () => {
		expect(resolveRineConfig({ payments: { autoPay: true } }).payments.autoPay).toBe(true);
		// Anything but a literal true stays OFF — no accidental truthy opt-in.
		expect(resolveRineConfig({ payments: { autoPay: "true" } }).payments.autoPay).toBe(false);
		expect(resolveRineConfig({ payments: {} }).payments.autoPay).toBe(false);
		expect(resolveRineConfig({ payments: "on" }).payments.autoPay).toBe(false);
	});

	it("honors a valid transport enum and falls back otherwise", () => {
		expect(resolveRineConfig({ transport: "poll" }).transport).toBe("poll");
		expect(resolveRineConfig({ transport: "expose" }).transport).toBe("expose");
		expect(resolveRineConfig({ transport: "bogus" }).transport).toBe("sse");
	});

	it("coerces numbers and rejects non-finite", () => {
		expect(resolveRineConfig({ pollIntervalMs: 1234 }).pollIntervalMs).toBe(1234);
		expect(resolveRineConfig({ pollIntervalMs: "nope" }).pollIntervalMs).toBe(60_000);
	});

	// 🔴 The retry cadence is the one set-aside bound an operator can move, so it is
	// also the one that can be handed a number that turns the retry off. Zero and a
	// negative are *valid finite numbers* — `asNumber` takes them, which is why this
	// field does not use it: a zero interval is a spinning timer and a negative one
	// makes every tick due forever. The manifest's `minimum` refuses them first, but
	// only on the path the host validates; a config record handed in directly, and
	// every call in this package's own tests, arrive here instead.
	it("floors a non-positive or unusable sweep interval back to the default", () => {
		expect(resolveRineConfig({ setasideSweepIntervalMs: 30_000 }).setasideSweepIntervalMs).toBe(
			30_000,
		);
		for (const bad of [0, -1, -300_000, "60000", null, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				resolveRineConfig({ setasideSweepIntervalMs: bad }).setasideSweepIntervalMs,
			).toBe(SETASIDE_SWEEP_INTERVAL_MS);
		}
	});

	it("normalizes an empty allowFrom array back to ['*']", () => {
		expect(resolveRineConfig({ allowFrom: [] }).allowFrom).toEqual(["*"]);
		expect(resolveRineConfig({ allowFrom: ["@acme", "x@y"] }).allowFrom).toEqual([
			"@acme",
			"x@y",
		]);
	});

	it("passes through string overrides", () => {
		const c = resolveRineConfig({
			agentId: "agent-1",
			baseUrl: "https://api.test",
			exposeBaseUrl: "https://gw.test",
		});
		expect(c.agentId).toBe("agent-1");
		expect(c.baseUrl).toBe("https://api.test");
		expect(c.exposeBaseUrl).toBe("https://gw.test");
	});
});


describe("resolveRineConfigFromCfg (channels.rine is authoritative)", () => {
	it("reads transport from channels.rine (the documented, authoritative home)", () => {
		// The bug: the notify service read plugins.entries.rine.config, so a channels.rine
		// transport was silently ignored and the service ran the sse default.
		const cfg = { channels: { rine: { transport: "poll", allowFrom: ["@acme"] } } };
		const c = resolveRineConfigFromCfg(cfg);
		expect(c.transport).toBe("poll");
		expect(c.allowFrom).toEqual(["@acme"]);
	});

	it("still honors plugins.entries.rine.config when channels.rine omits the field", () => {
		const cfg = {
			channels: { rine: { healthMonitor: { enabled: false } } },
			plugins: { entries: { rine: { config: { transport: "expose" } } } },
		};
		expect(resolveRineConfigFromCfg(cfg).transport).toBe("expose");
	});

	it("channels.rine wins over plugins.entries.rine.config per key, others merge", () => {
		const cfg = {
			channels: { rine: { transport: "poll" } },
			plugins: {
				entries: { rine: { config: { transport: "expose", pollIntervalMs: 1234 } } },
			},
		};
		const c = resolveRineConfigFromCfg(cfg);
		expect(c.transport).toBe("poll"); // channels.rine wins
		expect(c.pollIntervalMs).toBe(1234); // entries fills a gap channels.rine left
	});

	it("applies defaults on a config with no rine blocks or garbage input", () => {
		expect(resolveRineConfigFromCfg({}).transport).toBe("sse");
		expect(resolveRineConfigFromCfg(undefined).transport).toBe("sse");
		expect(resolveRineConfigFromCfg({ channels: "nope", plugins: 7 }).transport).toBe("sse");
	});
});

describe("readRineIdentity (no env mutation)", () => {
	const created: TestDirs[] = [];
	afterEach(() => {
		for (const d of created.splice(0)) d.dispose();
		delete process.env.RINE_CONFIG_DIR;
	});

	function fresh(): TestDirs {
		const dirs = freshDirs();
		created.push(dirs);
		return dirs;
	}

	it("threads an explicit configDir without writing process.env.RINE_CONFIG_DIR", () => {
		delete process.env.RINE_CONFIG_DIR;
		const dirs = fresh();
		const creds = readRineIdentity(
			resolveRineConfig({ configDir: dirs.configDir, baseUrl: "https://api.test" }),
		);
		expect(creds.configDir).toBe(dirs.configDir);
		expect(creds.ownerDir).toBe(dirs.ownerDir);
		expect(creds.apiUrl).toBe("https://api.test");
		expect(creds.auth).toBeUndefined();
		// The global env must be untouched — the prior bug mutated it.
		expect(process.env.RINE_CONFIG_DIR).toBeUndefined();
	});

	it("signs in as the agent while the owner dir holds an org root, and reads poll_url from the runtime profile", () => {
		delete process.env.RINE_CONFIG_DIR;
		const dirs = fresh();
		seedRuntime(dirs, "https://p");
		seedOrgIdentity(dirs.ownerDir);
		const creds = readRineIdentity(resolveRineConfig({ configDir: dirs.configDir }));
		expect(creds.auth?.agentId).toBe(TEST_AGENT);
		expect(creds.auth?.orgId).toBeTypeOf("string");
		expect(creds.pollUrl).toBe("https://p");
		expect(process.env.RINE_CONFIG_DIR).toBeUndefined();
	});

	it("surfaces core's upgrade error for a dir that holds only the retired credentials.json", () => {
		const dirs = fresh();
		writeFileSync(
			join(dirs.configDir, "credentials.json"),
			JSON.stringify({ default: { client_id: "cid", client_secret: "csec" } }),
		);
		// The runtime dir comes from the environment here: core refuses a discovered dir that
		// holds only the retired file, and the operator reads its upgrade text unchanged.
		process.env.RINE_CONFIG_DIR = dirs.configDir;
		expect(() => readRineIdentity(resolveRineConfig({}))).toThrow(/retired client_secret sign-in/);
	});
});
