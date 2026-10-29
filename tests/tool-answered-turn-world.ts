import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { type DeliverFn, replySpy, textSpy, turns } from "./tool-answered-turn-mocks.js";
import { registerSilentTurnHook } from "../src/silent-turn-hook.js";
import { registerToolAnswerHook } from "../src/tool-answer-hook.js";
import { makeRuntimeDispatcher } from "../src/runtime-dispatch.js";
import type { RineClient } from "../src/rine-client.js";
import type { RineInbound } from "../src/types.js";
import { logger, runtimeStub, sessionKeyFor } from "./helpers.js";

/** The shared world of the tool-answered-turn suites: the hooks as the host fires them, and one host turn. */

type Handler = (event: unknown, ctx: unknown) => void;

export const AGENT = "agent-1";
export const PEER = "alice@lab";
export const GROUP = "#ops@acme.rine.network";

const hooks = new Map<string, Handler>();
const api = { on: (name: string, h: Handler) => hooks.set(name, h) } as unknown as OpenClawPluginApi;
registerToolAnswerHook(api);
registerSilentTurnHook(api);
const hook = (name: string): Handler =>
	hooks.get(name) ?? (() => Promise.reject(new Error(`${name} not registered`)));
const afterToolCall = hook("after_tool_call");
const llmInput = hook("llm_input");
const llmOutput = hook("llm_output");

/** The host's wrapper around a tool's JSON payload: `details` holds the payload itself. */
export const jsonResult = (payload: unknown) => ({
	content: [{ type: "text", text: JSON.stringify(payload) }],
	details: payload,
});

type Call = { sessionKey: string; toolName: string; runId?: string; result?: unknown; error?: string };

/** The host reports a send tool's call, as made in the host run `runId` when it says which. */
export function toolCall({ sessionKey, ...event }: Call): void {
	afterToolCall({ params: {}, ...event }, { sessionKey });
}

/** The host starts the model run `runId` on the pointer text woken for message `messageId`. */
export function modelRun(sessionKey: string, runId: string, messageId: string): void {
	llmInput({ runId, prompt: `[rine rine.v1.dm from ${PEER}] message ${messageId} (read it)` }, { sessionKey });
}

/** The host ends a model call of run `runId`, whose answer is these texts. */
export function modelSays(sessionKey: string, runId: string, texts: string[]): void {
	llmOutput({ runId, assistantTexts: texts }, { sessionKey });
}

export function inbound(over: Partial<RineInbound> = {}): RineInbound {
	return {
		id: "m1",
		conversationId: "conv-1",
		fromHandle: PEER,
		type: "rine.v1.dm",
		isGroup: false,
		createdAt: "2026-06-09T00:00:00Z",
		encryptedPayload: "CIPHER",
		encryptionVersion: "hpke-hybrid-v2",
		...over,
	};
}

export const groupInbound = (over: Partial<RineInbound> = {}) =>
	inbound({ id: "g1", conversationId: "conv-g", isGroup: true, groupHandle: GROUP, ...over });

/** The session a message's turn runs on. */
export const sessionOf = (msg: RineInbound): string =>
	sessionKeyFor(AGENT, msg.isGroup ? msg.conversationId : msg.fromHandle);

/** One host turn: the model's work comes first (`during`), then the host delivers `answer`. */
export async function runTurn(
	msg: RineInbound,
	during: (sessionKey: string) => void | Promise<void>,
	log = logger(),
) {
	turns.set(msg.id, async (deliver: DeliverFn) => {
		await during(sessionOf(msg));
		await deliver({ text: "the final text" });
	});
	await makeRuntimeDispatcher({
		cfg: { agents: {} } as never,
		runtime: runtimeStub(),
		client: {} as RineClient,
		agentId: AGENT,
		logger: log,
	})(msg, new AbortController().signal);
	return log;
}

export const delivered = () => replySpy.mock.calls.length + textSpy.mock.calls.length;
