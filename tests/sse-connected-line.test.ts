import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/transports/poll.js", async () => (await import("./sse-helpers.js")).pollModuleMock);
vi.mock("../src/transports/cursor.js", async () => (await import("./sse-helpers.js")).cursorModuleMock);

import { streamConnectedLine } from "../src/constants.js";
import { runSseTransport } from "../src/transports/sse.js";
import { infoLines, makeTc, msgData, resetSseMocks, serveBodies, sseBodyBlocks } from "./sse-helpers.js";

afterEach(resetSseMocks);

// The fleet waits for this line before calling a deploy finished.
describe("runSseTransport stream-connected line", () => {
	it("logs it once per connection, whether the first frame is a heartbeat or a status", async () => {
		serveBodies([
			sseBodyBlocks(["event: heartbeat\ndata: {}", "event: heartbeat\ndata: {}"]),
			sseBodyBlocks(['event: status\ndata: {"status":"read"}']),
		]);
		const { tc } = makeTc();
		await runSseTransport(tc);
		expect(infoLines(tc)).toEqual([streamConnectedLine("sse", "a1"), streamConnectedLine("sse", "a1")]);
	});

	it("logs it at a catch-up message frame, before that frame's dispatch settles", async () => {
		serveBodies([sseBodyBlocks([`event: message\nid: e-1\ndata: ${msgData("e-1")}`])]);
		const { tc, ctrl } = makeTc();
		let linesAtDispatch: unknown[] = [];
		tc.onMessage = vi.fn(async () => {
			linesAtDispatch = infoLines(tc);
			ctrl.abort();
			return true;
		});
		await runSseTransport(tc);
		expect(linesAtDispatch).toEqual([streamConnectedLine("sse", "a1")]);
	});

	it("logs it once across every frame of a connection, message frames and the heartbeat after them included", async () => {
		serveBodies([
			sseBodyBlocks([
				`event: message\nid: e-1\ndata: ${msgData("e-1")}`,
				`event: message\nid: e-2\ndata: ${msgData("e-2")}`,
				"event: heartbeat\ndata: {}",
				`event: message\nid: e-3\ndata: ${msgData("e-3")}`,
			]),
		]);
		const { tc } = makeTc();
		await runSseTransport(tc);
		expect(tc.onMessage).toHaveBeenCalledTimes(3);
		expect(infoLines(tc)).toEqual([streamConnectedLine("sse", "a1")]);
	});

	it("names the transport and the agent in the line the fleet waits for", () => {
		expect(streamConnectedLine("sse", "agent-9")).toBe("rine: stream connected (transport=sse, agent=agent-9)");
		expect(streamConnectedLine("poll", "agent-9")).toBe("rine: stream connected (transport=poll, agent=agent-9)");
	});
});
