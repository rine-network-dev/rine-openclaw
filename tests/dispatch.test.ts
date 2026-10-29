import { describe, expect, it, vi } from "vitest";
import { makeOnMessage } from "../src/dispatch.js";
import type { RineClient } from "../src/rine-client.js";
import type { RineConfig, RineInbound } from "../src/types.js";
import { logger, rineConfig } from "./helpers.js";

function config(allowFrom: string[] = ["*"]): RineConfig {
	return rineConfig({
		pollIntervalMs: 1000,
		reconnectBaseMs: 100,
		reconnectMaxMs: 1000,
		allowFrom,
	});
}

function inbound(id: string, from = "alice@lab"): RineInbound {
	return {
		id,
		conversationId: `conv-${id}`,
		fromHandle: from,
		type: "rine.v1.dm",
		isGroup: false,
		encryptedPayload: "CIPHER",
		encryptionVersion: "hpke-hybrid-v2",
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

	// The transport's catch-up/live tag must reach the dispatcher (which gates
	// the auto-reply on it) — makeOnMessage forwards opts unchanged.
	it("forwards dispatch opts (replayed) through to the dispatch fn", async () => {
		const { onMessage, dispatch } = makeDeps({});
		await onMessage(inbound("m1"), { replayed: true });
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ id: "m1" }),
			expect.anything(),
			{ replayed: true },
		);
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

	it("logs a quarantined sender exactly once across repeated deliveries", async () => {
		const { onMessage, log } = makeDeps({ allowFrom: ["@acme"] });
		await onMessage(inbound("m1", "mallory@evil"));
		await onMessage(inbound("m1", "mallory@evil")); // reconnect replay
		await onMessage(inbound("m1", "mallory@evil"));
		const quarantineWarns = (log.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
			(c) => String(c[0]).includes("quarantined"),
		);
		expect(quarantineWarns).toHaveLength(1);
	});

	it("keeps a quarantined message recoverable (never dispatched, never marked)", async () => {
		const { onMessage, dispatch, markDelivered } = makeDeps({ allowFrom: ["@acme"] });
		await onMessage(inbound("m1", "mallory@evil"));
		expect(dispatch).not.toHaveBeenCalled();
		expect(markDelivered).not.toHaveBeenCalled();
	});

	it("logs one structured INFO line before dispatch carrying type/handle/id", async () => {
		const { onMessage, dispatch, log } = makeDeps({});
		await onMessage(inbound("m1", "alice@lab"));
		const info = log.info as ReturnType<typeof vi.fn>;
		expect(info).toHaveBeenCalledTimes(1);
		const line = String(info.mock.calls[0]?.[0]);
		expect(line).toContain("m1");
		expect(line).toContain("alice@lab");
		expect(line).toContain("rine.v1.dm");
		// The observability line must precede the agent-turn dispatch.
		const infoOrder = info.mock.invocationCallOrder[0] as number;
		const dispatchOrder = (dispatch as ReturnType<typeof vi.fn>).mock
			.invocationCallOrder[0] as number;
		expect(infoOrder).toBeLessThan(dispatchOrder);
	});

	it("does not re-log the inbound line on a deduped replay", async () => {
		const { onMessage, log } = makeDeps({});
		await onMessage(inbound("m1"));
		await onMessage(inbound("m1")); // reconnect replay
		expect(log.info).toHaveBeenCalledTimes(1);
	});

	it("does not log an inbound line for a quarantined sender", async () => {
		const { onMessage, log } = makeDeps({ allowFrom: ["@acme"] });
		await onMessage(inbound("m1", "mallory@evil"));
		expect(log.info).not.toHaveBeenCalled();
	});

	// Cursor contract (drives the SSE resume point): true = handled (cursor may advance),
	// false = dispatch failed (cursor must stay behind it so the message is retried).
	it("returns true after a successful delivery, and true again on a deduped replay", async () => {
		const { onMessage } = makeDeps({});
		expect(await onMessage(inbound("m1"))).toBe(true);
		expect(await onMessage(inbound("m1"))).toBe(true); // dedup — already handled, not a gap
	});

	it("returns false when dispatch fails (cursor must not advance past it)", async () => {
		const { onMessage } = makeDeps({
			dispatch: async () => {
				throw new Error("turn failed");
			},
		});
		expect(await onMessage(inbound("m1"))).toBe(false);
	});

	it("returns true for a quarantined sender (filtered, not a retryable gap)", async () => {
		const { onMessage } = makeDeps({ allowFrom: ["@acme"] });
		expect(await onMessage(inbound("m1", "mallory@evil"))).toBe(true);
	});
});
