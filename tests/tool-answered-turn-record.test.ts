import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replySpy, textSpy } from "./tool-answered-turn-mocks.js";
import {
	AGENT,
	PEER,
	inbound,
	jsonResult,
	modelRun,
	runTurn,
	toolCall,
} from "./tool-answered-turn-world.js";
import { closeTurn, openTurn, toolAnswer, type Turn } from "../src/tool-answers.js";
import { sessionKeyFor } from "./helpers.js";

// The record of what a turn's send tools delivered: shared across the registries' module
// instances, owned by the turn that made it, and bounded in age and size.

beforeEach(() => {
	replySpy.mockClear();
	textSpy.mockClear();
});

const send = (sessionKey: string, conversation: string, runId?: string, recipient?: string) =>
	toolCall({
		sessionKey,
		runId,
		toolName: "rine_send",
		result: jsonResult({ conversation_id: conversation, recipient_handle: recipient }),
	});

describe("the tool-answer record across module instances", () => {
	it("is shared, because the hook and `deliver` are loaded by different registries", async () => {
		const key = sessionKeyFor(AGENT, PEER);
		const turn = openTurn(key, "m1");
		vi.resetModules();
		const second = await import("../src/tool-answers.js");
		send(key, "conv-z");
		expect(second.toolAnswer(turn, { conversationId: "conv-z" })).toBeDefined();
		closeTurn(turn);
	});
});

describe("the tool-answer record's lifetime", () => {
	const key = sessionKeyFor(AGENT, PEER);
	let open: Turn[] = [];
	const begin = (sessionKey = key, messageId = "m1") => {
		const turn = openTurn(sessionKey, messageId);
		open.push(turn);
		return turn;
	};

	afterEach(() => {
		vi.useRealTimers();
		for (const turn of open) closeTurn(turn);
		open = [];
	});

	it("counts for nothing once ten minutes have passed", () => {
		vi.useFakeTimers();
		const turn = begin();
		send(key, "conv-old");
		expect(toolAnswer(turn, { conversationId: "conv-old" })).toBeDefined();
		vi.advanceTimersByTime(10 * 60_000 + 1);
		expect(toolAnswer(turn, { conversationId: "conv-old" })).toBeUndefined();
	});

	it("is dropped for the oldest sessions once a thousand sessions hold records", () => {
		const turns = Array.from({ length: 1001 }, (_, i) => begin(`session-${i}`));
		for (let i = 0; i < 1001; i++) send(`session-${i}`, `conv-${i}`);
		expect(toolAnswer(turns[0] as Turn, { conversationId: "conv-0" })).toBeUndefined();
		expect(toolAnswer(turns[1000] as Turn, { conversationId: "conv-1000" })).toBeDefined();
	});

	it("survives a second turn starting and ending on the session while the first still runs", () => {
		const first = begin(key, "m1");
		send(key, "conv-first");
		const second = begin(key, "m2");
		closeTurn(second);
		expect(toolAnswer(first, { conversationId: "conv-first" })).toBeDefined();
		closeTurn(first);
		expect(toolAnswer(first, { conversationId: "conv-first" })).toBeUndefined();
	});

	it("is dropped when the first turn on a session starts, so a run nobody dispatched cannot silence it", () => {
		send(key, "conv-stray");
		const turn = begin();
		expect(toolAnswer(turn, { conversationId: "conv-stray" })).toBeUndefined();
	});
});

describe("two turns running at once on one session", () => {
	const gate = () => {
		let open: () => void = () => {};
		const opened = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { opened, open };
	};

	/**
	 * Both messages are from one peer, so both turns run on one session, and both are still
	 * running when each model has done its work. `sender` is the turn whose model sent its answer
	 * to the peer through a send tool; `finishesFirst` is the turn that delivers first.
	 */
	async function overlap(sender: "first" | "second", finishesFirst: "first" | "second") {
		const waits = { first: gate(), second: gate() };
		const first = runTurn(inbound({ id: "m1" }), async (key) => {
			modelRun(key, "run-1", "m1");
			if (sender === "first") send(key, "conv-a", "run-1", PEER);
			await waits.first.opened;
		});
		const second = runTurn(inbound({ id: "m2", conversationId: "conv-2" }), async (key) => {
			modelRun(key, "run-2", "m2");
			if (sender === "second") send(key, "conv-b", "run-2", PEER);
			await waits.second.opened;
		});
		const running = { first, second };
		const later = finishesFirst === "first" ? "second" : "first";
		waits[finishesFirst].open();
		await running[finishesFirst];
		waits[later].open();
		await running[later];
		return replySpy.mock.calls.map(([id]) => id);
	}

	it.each(["first", "second"] as const)(
		"answers only the second turn when the first turn's model sent (the %s turn delivers first)",
		async (finishesFirst) => {
			expect(await overlap("first", finishesFirst)).toEqual(["m2"]);
		},
	);

	it.each(["first", "second"] as const)(
		"answers only the first turn when the second turn's model sent (the %s turn delivers first)",
		async (finishesFirst) => {
			expect(await overlap("second", finishesFirst)).toEqual(["m1"]);
		},
	);

	it("answers both turns, erring toward delivery, when a send was made with no run bound to a turn", async () => {
		const wait = gate();
		const first = runTurn(inbound({ id: "m1" }), () => wait.opened);
		await runTurn(inbound({ id: "m2", conversationId: "conv-2" }), (key) =>
			send(key, "conv-b", "run-2", PEER),
		);
		wait.open();
		await first;
		expect(replySpy.mock.calls.map(([id]) => id)).toEqual(["m2", "m1"]);
	});

	it("keeps answering the first turn's own send after the second turn has ended", async () => {
		const wait = gate();
		const first = runTurn(inbound({ id: "m1" }), async (key) => {
			modelRun(key, "run-1", "m1");
			send(key, "conv-a", "run-1", PEER);
			await wait.opened;
		});
		await runTurn(inbound({ id: "m2", conversationId: "conv-2" }), (key) => modelRun(key, "run-2", "m2"));
		wait.open();
		await first;
		expect(replySpy.mock.calls.map(([id]) => id)).toEqual(["m2"]);
	});
});
