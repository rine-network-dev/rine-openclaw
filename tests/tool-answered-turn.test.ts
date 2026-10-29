import { beforeEach, describe, expect, it } from "vitest";
import { replySpy, textSpy } from "./tool-answered-turn-mocks.js";
import { PEER, delivered, inbound, jsonResult, runTurn, toolCall } from "./tool-answered-turn-world.js";
import { sessionKeyFor } from "./helpers.js";

// A turn the model already answered through a send tool in the conversation it was woken for
// (or to the peer who sent it) must not also send its final text.

beforeEach(() => {
	replySpy.mockClear();
	textSpy.mockClear();
});

describe("a 1:1 turn the model already answered with a send tool", () => {
	it("sends no final text after rine_send into the conversation, and logs why", async () => {
		const log = await runTurn(inbound(), (sessionKey) =>
			toolCall({ sessionKey, toolName: "rine_send", result: jsonResult({ conversation_id: "conv-1" }) }),
		);
		expect(delivered()).toBe(0);
		expect(log.info).toHaveBeenCalledTimes(1);
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining("already sent into its conversation"));
	});

	it("sends no final text after a 1:1 rine_send the server put in a new conversation to the sender", async () => {
		const log = await runTurn(inbound(), (sessionKey) =>
			toolCall({
				sessionKey,
				toolName: "rine_send",
				result: jsonResult({ conversation_id: "conv-new", recipient_handle: PEER.toUpperCase() }),
			}),
		);
		expect(delivered()).toBe(0);
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining("already sent to its sender"));
	});

	it("reads the recipient from the message inside a rine_send_and_wait result", async () => {
		await runTurn(inbound(), (sessionKey) =>
			toolCall({
				sessionKey,
				toolName: "rine_send_and_wait",
				result: jsonResult({ message: { conversation_id: "conv-new", recipient_handle: PEER }, status: "ok" }),
			}),
		);
		expect(delivered()).toBe(0);
	});

	it("still sends the final text when a 1:1 send went to someone else", async () => {
		await runTurn(inbound(), (sessionKey) =>
			toolCall({
				sessionKey,
				toolName: "rine_send",
				result: jsonResult({ conversation_id: "conv-new", recipient_handle: "bob@lab" }),
			}),
		);
		expect(replySpy).toHaveBeenCalledTimes(1);
	});

	it("sends no final text after rine_send_and_wait into the conversation", async () => {
		await runTurn(inbound(), (sessionKey) =>
			toolCall({
				sessionKey,
				toolName: "rine_send_and_wait",
				result: jsonResult({ message: { conversation_id: "conv-1" }, conversation_id: "conv-1", status: "ok" }),
			}),
		);
		expect(delivered()).toBe(0);
	});

	it("still sends the final text when the send went into another conversation", async () => {
		await runTurn(inbound(), (sessionKey) =>
			toolCall({ sessionKey, toolName: "rine_send", result: jsonResult({ conversation_id: "conv-other" }) }),
		);
		expect(replySpy).toHaveBeenCalledTimes(1);
	});

	it("still sends the final text when the send call failed", async () => {
		await runTurn(inbound(), (sessionKey) =>
			toolCall({ sessionKey, toolName: "rine_send", error: "network down" }),
		);
		expect(replySpy).toHaveBeenCalledTimes(1);
	});

	it("still sends the final text when the tool returned an error result", async () => {
		await runTurn(inbound(), (sessionKey) =>
			toolCall({
				sessionKey,
				toolName: "rine_send",
				result: jsonResult({ error: "rine: rine_send failed: boom", conversation_id: "conv-1" }),
			}),
		);
		expect(replySpy).toHaveBeenCalledTimes(1);
	});

	it("still sends the final text after a tool that sends nothing", async () => {
		await runTurn(inbound(), (sessionKey) =>
			toolCall({ sessionKey, toolName: "rine_read", result: jsonResult({ conversation_id: "conv-1" }) }),
		);
		expect(replySpy).toHaveBeenCalledTimes(1);
	});

	it("still sends the final text when the send ran on another session", async () => {
		await runTurn(inbound(), () =>
			toolCall({
				sessionKey: sessionKeyFor("agent-1", "bob@lab"),
				toolName: "rine_send",
				result: jsonResult({ conversation_id: "conv-1" }),
			}),
		);
		expect(replySpy).toHaveBeenCalledTimes(1);
	});

	it("does not carry the answer over to the next turn on the session", async () => {
		await runTurn(inbound(), (sessionKey) =>
			toolCall({ sessionKey, toolName: "rine_send", result: jsonResult({ conversation_id: "conv-1" }) }),
		);
		await runTurn(inbound({ id: "m2" }), () => {});
		expect(replySpy).toHaveBeenCalledTimes(1);
	});
});

