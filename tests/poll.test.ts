import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "openclaw/plugin-sdk";
import type { MessageRead } from "@rine-network/core";
import { runPollTransport } from "../src/transports/poll.js";
import type { TransportContext } from "../src/transports/context.js";
import type { RineClient } from "../src/rine-client.js";
import type { RineConfig } from "../src/types.js";

function logger(): PluginLogger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function config(): RineConfig {
	return {
		transport: "poll",
		pollIntervalMs: 5,
		reconnectBaseMs: 100,
		reconnectMaxMs: 1000,
		a2aAcceptCleartext: true,
		allowFrom: ["*"],
	};
}

function msg(id: string): MessageRead {
	return {
		id,
		conversation_id: `c-${id}`,
		type: "rine.v1.dm",
		encrypted_payload: "X",
		encryption_version: "hpke-v1",
		sender_handle: "alice@lab",
		created_at: "2026-06-09T00:00:00Z",
	};
}

describe("runPollTransport", () => {
	it("does no JWT mint / no /messages fetch when count is 0", async () => {
		const ctrl = new AbortController();
		const pollCount = vi.fn(async () => 0);
		const fetchNewMessages = vi.fn(async () => [] as MessageRead[]);
		const getJwt = vi.fn(async () => "jwt");
		const client = { pollCount, fetchNewMessages, getJwt } as unknown as RineClient;
		const onMessage = vi.fn(async () => true);
		const tc: TransportContext = {
			client,
			config: config(),
			agentId: "a1",
			logger: logger(),
			onMessage,
			signal: ctrl.signal,
			pollUrl: "https://rine.test/poll/tok",
		};
		const run = runPollTransport(tc);
		// let a couple of cycles run, then abort
		await new Promise((r) => setTimeout(r, 25));
		ctrl.abort();
		await run;
		expect(pollCount).toHaveBeenCalled();
		expect(getJwt).not.toHaveBeenCalled();
		expect(fetchNewMessages).not.toHaveBeenCalled();
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("fetches + dispatches when count > 0", async () => {
		const ctrl = new AbortController();
		let polled = 0;
		const pollCount = vi.fn(async () => (polled++ === 0 ? 2 : 0));
		const fetchNewMessages = vi.fn(async () => [msg("m1"), msg("m2")]);
		const client = { pollCount, fetchNewMessages } as unknown as RineClient;
		const dispatched: string[] = [];
		const onMessage = vi.fn(async (m: { id: string }) => {
			dispatched.push(m.id);
			return true;
		});
		const tc: TransportContext = {
			client,
			config: config(),
			agentId: "a1",
			logger: logger(),
			onMessage,
			signal: ctrl.signal,
			pollUrl: "https://rine.test/poll/tok",
		};
		const run = runPollTransport(tc);
		await new Promise((r) => setTimeout(r, 25));
		ctrl.abort();
		await run;
		expect(fetchNewMessages).toHaveBeenCalledWith("a1");
		expect(dispatched).toEqual(["m1", "m2"]);
	});

	it("logs and exits when poll_url is missing", async () => {
		const log = logger();
		const tc: TransportContext = {
			client: {} as unknown as RineClient,
			config: config(),
			agentId: "a1",
			logger: log,
			onMessage: vi.fn(),
			signal: new AbortController().signal,
			pollUrl: undefined,
		};
		await runPollTransport(tc);
		expect(log.error).toHaveBeenCalledWith(expect.stringContaining("poll_url"));
	});
});
