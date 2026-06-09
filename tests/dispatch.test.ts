import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { makeOnMessage } from "../src/dispatch.js";
import type { RineClient } from "../src/rine-client.js";
import type { RineConfig, RineInbound } from "../src/types.js";

function logger(): PluginLogger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function config(allowFrom: string[] = ["*"]): RineConfig {
	return {
		transport: "sse",
		pollIntervalMs: 1000,
		reconnectBaseMs: 100,
		reconnectMaxMs: 1000,
		a2aAcceptCleartext: true,
		allowFrom,
	};
}

function inbound(id: string, from = "alice@lab"): RineInbound {
	return {
		id,
		conversationId: `conv-${id}`,
		fromHandle: from,
		type: "rine.v1.dm",
		isGroup: false,
		encryptedPayload: "CIPHER",
		encryptionVersion: "hpke-v1",
	};
}

function makeDeps(opts: {
	allowFrom?: string[];
	dispatch?: (m: RineInbound, s: AbortSignal) => Promise<void>;
	markDelivered?: ReturnType<typeof vi.fn>;
}) {
	const log = logger();
	const markDelivered = opts.markDelivered ?? vi.fn(async () => 1);
	const client = { markDelivered } as unknown as RineClient;
	const dispatch = vi.fn(opts.dispatch ?? (async () => {}));
	const onMessage = makeOnMessage({
		client,
		config: config(opts.allowFrom),
		agentId: "agent-1",
		logger: log,
		dispatch,
		signal: new AbortController().signal,
	});
	return { onMessage, dispatch, markDelivered, log };
}

describe("makeOnMessage", () => {
	it("dispatches exactly once and marks delivered after success", async () => {
		const { onMessage, dispatch, markDelivered } = makeDeps({});
		await onMessage(inbound("m1"));
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(markDelivered).toHaveBeenCalledWith("agent-1", ["m1"]);
	});

	it("dedupes by message id, even across a simulated reconnect", async () => {
		const { onMessage, dispatch, markDelivered } = makeDeps({});
		await onMessage(inbound("m1"));
		await onMessage(inbound("m1")); // duplicate (reconnect replay)
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(markDelivered).toHaveBeenCalledTimes(1);
	});

	it("does NOT mark delivered when dispatch throws, and re-enables retry", async () => {
		let calls = 0;
		const { onMessage, markDelivered } = makeDeps({
			dispatch: async () => {
				calls += 1;
				if (calls === 1) throw new Error("turn failed");
			},
		});
		await onMessage(inbound("m1")); // fails
		expect(markDelivered).not.toHaveBeenCalled();
		await onMessage(inbound("m1")); // re-eligible, succeeds
		expect(calls).toBe(2);
		expect(markDelivered).toHaveBeenCalledWith("agent-1", ["m1"]);
	});

	it("quarantines a disallowed sender (logged, no dispatch, not marked)", async () => {
		const { onMessage, dispatch, markDelivered, log } = makeDeps({
			allowFrom: ["@acme"],
		});
		await onMessage(inbound("m1", "mallory@evil"));
		expect(dispatch).not.toHaveBeenCalled();
		expect(markDelivered).not.toHaveBeenCalled();
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("quarantined"));
	});

	it("allows an org-scoped sender via @org", async () => {
		const { onMessage, dispatch } = makeDeps({ allowFrom: ["@lab"] });
		await onMessage(inbound("m1", "alice@lab"));
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it("logs a quarantined sender exactly once across repeated deliveries (NR-3)", async () => {
		const { onMessage, log } = makeDeps({ allowFrom: ["@acme"] });
		await onMessage(inbound("m1", "mallory@evil"));
		await onMessage(inbound("m1", "mallory@evil")); // reconnect replay
		await onMessage(inbound("m1", "mallory@evil"));
		const quarantineWarns = (log.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
			(c) => String(c[0]).includes("quarantined"),
		);
		expect(quarantineWarns).toHaveLength(1);
	});

	it("keeps a quarantined message recoverable (never dispatched, never marked) (NR-3)", async () => {
		const { onMessage, dispatch, markDelivered } = makeDeps({ allowFrom: ["@acme"] });
		await onMessage(inbound("m1", "mallory@evil"));
		expect(dispatch).not.toHaveBeenCalled();
		expect(markDelivered).not.toHaveBeenCalled();
	});
});
