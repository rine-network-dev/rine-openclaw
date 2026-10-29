import { beforeEach, describe, expect, it } from "vitest";
import { replySpy, textSpy } from "./tool-answered-turn-mocks.js";
import { GROUP, delivered, groupInbound, jsonResult, runTurn, toolCall } from "./tool-answered-turn-world.js";

// A group turn the model already answered with a send to the group must not also post its final text.

beforeEach(() => {
	replySpy.mockClear();
	textSpy.mockClear();
});

describe("a group turn the model already answered with rine_send", () => {
	it("sends no final text after a send to that group", async () => {
		const log = await runTurn(groupInbound(), (sessionKey) =>
			toolCall({
				sessionKey,
				toolName: "rine_send",
				result: jsonResult({ conversation_id: "conv-g", group_handle: GROUP }),
			}),
		);
		expect(delivered()).toBe(0);
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining("already sent to its group"));
	});

	it("matches the group handle whatever its case", async () => {
		await runTurn(groupInbound(), (sessionKey) =>
			toolCall({
				sessionKey,
				toolName: "rine_send",
				result: jsonResult({ conversation_id: "conv-g", group_handle: GROUP.toUpperCase() }),
			}),
		);
		expect(delivered()).toBe(0);
	});

	it("still posts the final text when the model sent to another group", async () => {
		await runTurn(groupInbound(), (sessionKey) =>
			toolCall({
				sessionKey,
				toolName: "rine_send",
				result: jsonResult({ conversation_id: "conv-x", group_handle: "#other@acme.rine.network" }),
			}),
		);
		expect(textSpy).toHaveBeenCalledTimes(1);
	});

	it("still posts the final text when the group send failed", async () => {
		await runTurn(groupInbound(), (sessionKey) =>
			toolCall({ sessionKey, toolName: "rine_send", error: "refused" }),
		);
		expect(textSpy).toHaveBeenCalledTimes(1);
	});
});

