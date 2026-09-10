/**
 * Behavioral tests for rinePlugin.setupWizard.
 * Asserts observable outcomes from the prepare hook and resolveConfigured —
 * not internal call sequences.
 */
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
import { describe, expect, it } from "vitest";
import { rinePlugin } from "../src/channel.js";

// Minimal OpenClawConfig shape required by the prepare/resolveConfigured hooks.
// We only need the `channels` field; everything else is opaque to these tests.
type MinimalCfg = Record<string, unknown>;

function makeCfg(channels?: Record<string, unknown>): MinimalCfg {
	return channels !== undefined ? { channels } : {};
}

// `setupWizard` is typed as the union ChannelSetupWizard | ChannelSetupWizardAdapter;
// rine always supplies the concrete ChannelSetupWizard form. Narrow so the tests can
// reach .prepare/.status/.credentials (the adapter branch lacks them).
const wizard = rinePlugin.setupWizard as ChannelSetupWizard | undefined;

describe("rinePlugin.setupWizard", () => {
	it("wizard is defined on the plugin", () => {
		expect(wizard).toBeDefined();
	});

	describe("prepare hook", () => {
		it("scaffolds channels.rine when block is absent", () => {
			const cfg = makeCfg();
			const result = wizard?.prepare?.({
				cfg: cfg as never,
				accountId: "default",
				credentialValues: {},
				runtime: {} as never,
				prompter: {} as never,
			});
			expect(result).toBeDefined();
			const patched = (result as { cfg: MinimalCfg }).cfg;
			const rineCh = (patched.channels as Record<string, unknown>).rine as Record<
				string,
				unknown
			>;
			expect(rineCh).toBeDefined();
			expect(rineCh.transport).toBe("sse");
			expect((rineCh.healthMonitor as Record<string, unknown>).enabled).toBe(false);
		});

		it("scaffolds channels.rine when channels block exists but has no rine key", () => {
			const cfg = makeCfg({ slack: { token: "xoxb-test" } });
			const result = wizard?.prepare?.({
				cfg: cfg as never,
				accountId: "default",
				credentialValues: {},
				runtime: {} as never,
				prompter: {} as never,
			});
			const patched = (result as { cfg: MinimalCfg }).cfg;
			const channels = patched.channels as Record<string, unknown>;
			// Existing keys preserved
			expect(channels.slack).toBeDefined();
			// rine block added
			const rineCh = channels.rine as Record<string, unknown>;
			expect(rineCh.transport).toBe("sse");
			expect((rineCh.healthMonitor as Record<string, unknown>).enabled).toBe(false);
		});

		it("is a no-op (returns undefined) when channels.rine already exists", () => {
			const cfg = makeCfg({ rine: { transport: "poll", healthMonitor: { enabled: true } } });
			const result = wizard?.prepare?.({
				cfg: cfg as never,
				accountId: "default",
				credentialValues: {},
				runtime: {} as never,
				prompter: {} as never,
			});
			// No-op: returns undefined (falsy), existing config untouched
			expect(result == null).toBe(true);
		});

		it("does not clobber existing rine config when block is present", () => {
			const existing = { transport: "expose", healthMonitor: { enabled: true } };
			const cfg = makeCfg({ rine: existing });
			wizard?.prepare?.({
				cfg: cfg as never,
				accountId: "default",
				credentialValues: {},
				runtime: {} as never,
				prompter: {} as never,
			});
			// Original cfg is not mutated
			const ch = (cfg.channels as Record<string, unknown>).rine as Record<string, unknown>;
			expect(ch.transport).toBe("expose");
		});
	});

	describe("status.resolveConfigured", () => {
		it("returns false when channels.rine is absent", () => {
			const cfg = makeCfg();
			const result = wizard?.status.resolveConfigured({ cfg: cfg as never });
			expect(result).toBe(false);
		});

		it("returns false when channels exists but has no rine key", () => {
			const cfg = makeCfg({ slack: {} });
			const result = wizard?.status.resolveConfigured({ cfg: cfg as never });
			expect(result).toBe(false);
		});

		it("returns true when channels.rine is an object", () => {
			const cfg = makeCfg({ rine: { transport: "sse" } });
			const result = wizard?.status.resolveConfigured({ cfg: cfg as never });
			expect(result).toBe(true);
		});

		it("returns false when channels.rine is null", () => {
			const cfg = makeCfg({ rine: null });
			const result = wizard?.status.resolveConfigured({ cfg: cfg as never });
			expect(result).toBe(false);
		});
	});

	describe("credentials", () => {
		it("has an empty credentials array (rine creds live outside openclaw.json)", () => {
			expect(wizard?.credentials).toEqual([]);
		});
	});

	describe("status labels", () => {
		it("has expected configured/unconfigured labels", () => {
			expect(wizard?.status.configuredLabel).toBe("rine configured");
			expect(wizard?.status.unconfiguredLabel).toBe("rine not configured");
		});
	});
});
