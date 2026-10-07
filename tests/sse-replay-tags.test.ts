import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/transports/poll.js", async () => (await import("./sse-helpers.js")).pollModuleMock);
vi.mock("../src/transports/cursor.js", async () => (await import("./sse-helpers.js")).cursorModuleMock);

import { runSseTransport } from "../src/transports/sse.js";
import { FRESH_CATCHUP_WINDOW_MS } from "../src/transports/catchup.js";
import {
	loadCursorMock,
	makeTc,
	msgData,
	msgDataAged,
	resetSseMocks,
	serveBodies,
	sseBodyBlocks,
} from "./sse-helpers.js";

afterEach(resetSseMocks);

type Seen = Array<{ id: string; replayed: boolean | undefined }>;

/** Serve one connect's frames, run the transport, and report every dispatch's `replayed` tag in order. */
async function dispatchTags(blocks: string[]): Promise<Seen> {
	serveBodies([sseBodyBlocks(blocks)]);
	const { tc } = makeTc();
	const seen: Seen = [];
	tc.onMessage = vi.fn(async (m: { id: string }, opts?: { replayed?: boolean }) => {
		seen.push({ id: m.id, replayed: opts?.replayed });
		return true;
	});
	await runSseTransport(tc);
	return seen;
}

/** Run one cursorless connect delivering the frames as catch-up; report each frame's `replayed` tag. */
async function tagsOf(frames: Array<{ id: string; ageMs: number }>): Promise<Record<string, boolean | undefined>> {
	const seen = await dispatchTags(frames.map((f) => `event: message\nid: ${f.id}\ndata: ${msgDataAged(f.id, f.ageMs)}`));
	return Object.fromEntries(seen.map((s) => [s.id, s.replayed]));
}

describe("runSseTransport replay tagging", () => {
	// Catch-up (Phase-1) message frames arrive before the first heartbeat/status
	// frame — they must be dispatched as `replayed:true` (wake to act, no auto-reply). The
	// server emits a heartbeat at the catch-up->live boundary, so the first heartbeat/status
	// flips the stream to live; later message frames are `replayed:false`.
	it("tags pre-heartbeat frames as replayed (catch-up) and post-heartbeat frames as live", async () => {
		expect(
			await dispatchTags([
				`event: message\nid: e-1\ndata: ${msgData("e-1")}`, // catch-up
				`event: message\nid: e-2\ndata: ${msgData("e-2")}`, // still catch-up
				"event: heartbeat\ndata: {}", // → live phase begins
				`event: message\nid: e-3\ndata: ${msgData("e-3")}`, // live
			]),
		).toEqual([
			{ id: "e-1", replayed: true },
			{ id: "e-2", replayed: true },
			{ id: "e-3", replayed: false },
		]);
	});

	it("flips to live on a status frame too (not only heartbeats)", async () => {
		expect(
			await dispatchTags([
				'event: status\ndata: {"conversation_id":"c1","status":"read"}',
				`event: message\nid: e-9\ndata: ${msgData("e-9")}`,
			]),
		).toEqual([{ id: "e-9", replayed: false }]);
	});

	// Regression: a cursor-bearing connect (steady state after the first delivery /
	// any restart with a persisted cursor) resumes past the last DELIVERED message, so its
	// catch-up is bounded to genuinely-new undelivered messages. Those must auto-reply from the
	// first frame — WITHOUT waiting for a heartbeat: a cursor-bearing connect is live from the
	// start, whether or not the boundary heartbeat has arrived yet. This guards the two failure
	// modes the audit found: a busy `persistent=true` stream whose queue never idles 30s (no
	// idle heartbeat) and the first-DM-after-connect window.
	it("dispatches a cursor-bearing connect's frames as live (auto-reply) with no heartbeat", async () => {
		loadCursorMock.mockReturnValue("m-seed");
		expect(
			await dispatchTags([
				`event: message\nid: e-1\ndata: ${msgData("e-1")}`,
				`event: message\nid: e-2\ndata: ${msgData("e-2")}`,
			]),
		).toEqual([
			{ id: "e-1", replayed: false },
			{ id: "e-2", replayed: false },
		]);
	});

	// A cursorless first connect must not send a minutes-old question down the no-reply path.
	it("dispatches a cursorless connect's recent catch-up frame as live", async () => {
		expect(await tagsOf([{ id: "e-1", ageMs: 30_000 }])).toEqual({ "e-1": false });
	});

	it("keeps the replay treatment for a catch-up frame older than the fresh window", async () => {
		expect(await tagsOf([{ id: "e-1", ageMs: FRESH_CATCHUP_WINDOW_MS + 60_000 }])).toEqual({ "e-1": true });
	});

	it("tags each catch-up frame by its own age, not the batch's", async () => {
		const seen = await tagsOf([
			{ id: "old", ageMs: 3 * 60 * 60_000 },
			{ id: "new", ageMs: 20_000 },
		]);
		expect(seen).toEqual({ old: true, new: false });
	});

	it("judges every catch-up frame's age at the moment the stream opened, not after the earlier frames' turns", async () => {
		let clock = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		serveBodies([
			sseBodyBlocks(
				["first", "second", "third"].map(
					(id) => `event: message\nid: ${id}\ndata: ${msgDataAged(id, FRESH_CATCHUP_WINDOW_MS - 60_000)}`,
				),
			),
		]);
		const { tc } = makeTc();
		const seen: Record<string, boolean | undefined> = {};
		tc.onMessage = vi.fn(async (m: { id: string }, opts?: { replayed?: boolean }) => {
			seen[m.id] = opts?.replayed;
			clock += 5 * 60_000; // each turn takes five minutes
			return true;
		});
		await runSseTransport(tc);
		expect(seen).toEqual({ first: false, second: false, third: false });
	});
});
