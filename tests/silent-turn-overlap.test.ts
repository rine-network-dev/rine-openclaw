import { beforeEach, describe, expect, it } from "vitest";
import { replySpy, textSpy } from "./tool-answered-turn-mocks.js";
import { inbound, modelRun, modelSays, runTurn } from "./tool-answered-turn-world.js";

// Two inbound messages from one peer share a session and may be answered at once. A model's
// NO_REPLY belongs to the turn whose run said it: it never silences the other turn's answer, and
// the other turn's answer never erases it.

beforeEach(() => {
	replySpy.mockClear();
	textSpy.mockClear();
});

type Side = "first" | "second";

const gate = () => {
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
};

/**
 * Both turns are running when their models answer. `silent` is the turn whose model answers
 * NO_REPLY (the other answers with text); `silentFirst` is whether that answer reaches the host's
 * hook before the other turn's; `finishesFirst` is the turn that delivers first.
 */
async function overlap(silent: Side, silentFirst: boolean, finishesFirst: Side = "first") {
	const waits = { first: gate(), second: gate() };
	const keys: string[] = [];
	const first = runTurn(inbound({ id: "m1" }), async (key) => {
		keys.push(key);
		modelRun(key, "run-1", "m1");
		await waits.first.opened;
	});
	const second = runTurn(inbound({ id: "m2", conversationId: "conv-2" }), async (key) => {
		modelRun(key, "run-2", "m2");
		await waits.second.opened;
	});
	const said = (turn: Side) => {
		const text = silent === turn ? "NO_REPLY" : "Here it is";
		modelSays(keys[0] as string, turn === "first" ? "run-1" : "run-2", [text]);
	};
	const other: Side = silent === "first" ? "second" : "first";
	for (const turn of silentFirst ? [silent, other] : [other, silent]) said(turn);
	const running = { first, second };
	const later = finishesFirst === "first" ? "second" : "first";
	waits[finishesFirst].open();
	await running[finishesFirst];
	waits[later].open();
	await running[later];
	return replySpy.mock.calls.map(([id]) => id);
}

describe("two turns running at once on one session, one answered NO_REPLY", () => {
	it.each([true, false])(
		"answers only the second turn when the first turn's model said NO_REPLY (said first: %s)",
		async (silentFirst) => {
			expect(await overlap("first", silentFirst)).toEqual(["m2"]);
		},
	);

	it.each([true, false])(
		"answers only the first turn when the second turn's model said NO_REPLY (said first: %s)",
		async (silentFirst) => {
			expect(await overlap("second", silentFirst)).toEqual(["m1"]);
		},
	);

	it("answers the other turn however the two finish", async () => {
		expect(await overlap("first", true, "second")).toEqual(["m2"]);
	});

	it("answers both turns, erring toward delivery, when the NO_REPLY came from a run bound to neither", async () => {
		const wait = gate();
		const keys: string[] = [];
		const first = runTurn(inbound({ id: "m1" }), async (key) => {
			keys.push(key);
			modelRun(key, "run-1", "m1");
			await wait.opened;
		});
		const second = runTurn(inbound({ id: "m2", conversationId: "conv-2" }), async (key) => {
			modelRun(key, "run-2", "m2");
			modelSays(key, "run-elsewhere", ["NO_REPLY"]);
			wait.open();
		});
		await Promise.all([first, second]);
		expect(replySpy.mock.calls.map(([id]) => id).sort()).toEqual(["m1", "m2"]);
	});
});
