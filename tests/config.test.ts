import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readRineCredentials,
	resolveRineConfig,
	resolveRineConfigFromCfg,
} from "../src/config.js";

describe("resolveRineConfig", () => {
	it("applies defaults on an empty config", () => {
		const c = resolveRineConfig({});
		expect(c.transport).toBe("sse");
		expect(c.pollIntervalMs).toBe(60_000);
		expect(c.reconnectBaseMs).toBe(3_000);
		expect(c.reconnectMaxMs).toBe(300_000);
		expect(c.a2aAcceptCleartext).toBe(true);
		expect(c.allowFrom).toEqual(["*"]);
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


describe("resolveRineConfigFromCfg (REQ-FSH-03: channels.rine is authoritative)", () => {
	it("reads transport from channels.rine (the documented, activation-required home)", () => {
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

describe("readRineCredentials (QP-4: no env mutation)", () => {
	const created: string[] = [];
	afterEach(() => {
		for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
		delete process.env.RINE_CONFIG_DIR;
	});

	it("threads an explicit configDir without writing process.env.RINE_CONFIG_DIR", () => {
		delete process.env.RINE_CONFIG_DIR;
		const dir = mkdtempSync(join(tmpdir(), "rine-cfg-"));
		created.push(dir);
		const creds = readRineCredentials(
			resolveRineConfig({ configDir: dir, baseUrl: "https://api.test" }),
		);
		expect(creds.configDir).toBe(dir);
		expect(creds.apiUrl).toBe("https://api.test");
		// The global env must be untouched — the prior bug mutated it.
		expect(process.env.RINE_CONFIG_DIR).toBeUndefined();
	});

	it("reads credentials from the threaded dir (entry present)", () => {
		delete process.env.RINE_CONFIG_DIR;
		delete process.env.RINE_CLIENT_ID;
		delete process.env.RINE_CLIENT_SECRET;
		const dir = mkdtempSync(join(tmpdir(), "rine-cfg-"));
		created.push(dir);
		writeFileSync(
			join(dir, "credentials.json"),
			JSON.stringify({ default: { client_id: "cid", client_secret: "csec", poll_url: "https://p" } }),
		);
		const creds = readRineCredentials(resolveRineConfig({ configDir: dir }));
		expect(creds.entry?.client_id).toBe("cid");
		expect(creds.pollUrl).toBe("https://p");
		expect(process.env.RINE_CONFIG_DIR).toBeUndefined();
	});
});
