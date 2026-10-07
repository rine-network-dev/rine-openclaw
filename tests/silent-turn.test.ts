import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A direct-chat turn that ends on NO_REPLY is not silent to the host: it runs a finalization pass
// and hands its text (or a canned fallback) to `deliver`, which used to send it to the peer — whose
// own turn did the same, indefinitely. The `llm_output` hook is where the model's own answer is
// visible; `deliver` must honour it. The dispatch helper is mocked, so the test plays the host's
// part: it fires the hook for the session and then calls `deliver` with the finalization text.

type DeliverFn = (payload: { text?: string }) => Promise<void>;
type Handler = (event: unknown, ctx: unknown) => void;

let turn: (deliver: DeliverFn) => Promise<void> = async () => {};
vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
	dispatchInboundDirectDmWithRuntime: (params: { deliver: DeliverFn }) => turn(params.deliver),
}));

const sendReplySpy = vi.fn(async () => ({}));
vi.mock("../src/outbound.js", () => ({
	sendRineReply: () => sendReplySpy(),
	sendRineText: vi.fn(async () => ({ messageId: "srv-1" })),
}));

import { makeRuntimeDispatcher } from "../src/runtime-dispatch.js";
import { forgetSilentTurn, registerSilentTurnHook } from "../src/silent-turn-hook.js";
import type { RineClient } from "../src/rine-client.js";
import type { RineInbound } from "../src/types.js";
import { logger, runtimeStub, sessionKeyFor } from "./helpers.js";

const AGENT = "agent-1";
const PEER = "alice@lab";

const llmOutput: { fire: Handler } = (() => {
	const hooks = new Map<string, Handler>();
	registerSilentTurnHook({ on: (name: string, h: Handler) => hooks.set(name, h) } as unknown as OpenClawPluginApi);
	return { fire: hooks.get("llm_output") ?? (() => Promise.reject(new Error("llm_output not registered"))) };
})();

/** The model finishes a model call with these texts, on the session of a DM from the peer. */
function modelSays(texts: string[]): void {
	llmOutput.fire({ assistantTexts: texts }, { sessionKey: sessionKeyFor(AGENT, PEER) });
}

function inbound(over: Partial<RineInbound> = {}): RineInbound {
	return {
		id: "m1",
		conversationId: "conv-1",
		fromHandle: PEER,
		type: "rine.v1.dm",
		isGroup: false,
		createdAt: "2026-06-09T00:00:00Z",
		encryptedPayload: "CIPHER",
		encryptionVersion: "hpke-v1",
		...over,
	};
}

/** One host turn: the model's calls come first (`during`), then the host delivers `answer`. */
async function runTurn(msg: RineInbound, during: () => void, answer: string): Promise<void> {
	turn = async (deliver) => {
		during();
		await deliver({ text: answer });
	};
	await makeRuntimeDispatcher({
		cfg: { agents: {} } as never,
		runtime: runtimeStub(),
		client: {} as RineClient,
		agentId: AGENT,
		logger: logger(),
	})(msg, new AbortController().signal);
}

describe("a turn the model answered with NO_REPLY", () => {
	beforeEach(() => sendReplySpy.mockClear());

	it("sends nothing, even though the host delivers its finalization text", async () => {
		await runTurn(inbound(), () => modelSays(["NO_REPLY"]), "Acknowledged, no reply needed.");
		expect(sendReplySpy).not.toHaveBeenCalled();
	});

	it("looks at the model's last text of the turn, not its first", async () => {
		await runTurn(inbound(), () => modelSays(["Reading it now.", "NO_REPLY"]), "wrap-up");
		expect(sendReplySpy).not.toHaveBeenCalled();
	});

	it("still sends a turn the model answered with text", async () => {
		await runTurn(inbound(), () => modelSays(["Here is the quote"]), "Here is the quote");
		expect(sendReplySpy).toHaveBeenCalledTimes(1);
	});

	it("is forgotten once a later model call of the turn answers with text", async () => {
		await runTurn(inbound(), () => {
			modelSays(["NO_REPLY"]);
			modelSays(["Actually, here is the quote"]);
		}, "Actually, here is the quote");
		expect(sendReplySpy).toHaveBeenCalledTimes(1);
	});

	it("does not carry over to the next turn on the same session", async () => {
		await runTurn(inbound(), () => modelSays(["NO_REPLY"]), "wrap-up");
		// The next turn's model call never reaches the hook (the host skipped it), yet its
		// delivery must not inherit the silence of the turn before.
		await runTurn(inbound({ id: "m2" }), () => {}, "A real answer");
		expect(sendReplySpy).toHaveBeenCalledTimes(1);
	});
});

describe("the silent-turn record across module instances", () => {
	it("is shared, because the hook and `deliver` are loaded by different registries", async () => {
		const key = sessionKeyFor(AGENT, PEER);
		vi.resetModules();
		const second = await import("../src/silent-turn-hook.js");
		llmOutput.fire({ assistantTexts: ["NO_REPLY"] }, { sessionKey: key });
		expect(second.answeredSilently(key)).toBe(true);
		forgetSilentTurn(key);
	});
});
