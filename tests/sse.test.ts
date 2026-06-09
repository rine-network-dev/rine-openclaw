import { describe, expect, it } from "vitest";
import { parseSseBlock } from "../src/transports/sse.js";

describe("parseSseBlock", () => {
	it("parses an event with id + data", () => {
		const evt = parseSseBlock("event: message\nid: m-7\ndata: {\"id\":\"m-7\"}");
		expect(evt).toEqual({ event: "message", id: "m-7", data: '{"id":"m-7"}' });
	});

	it("defaults event to 'message' and joins multi-line data", () => {
		const evt = parseSseBlock("data: line1\ndata: line2");
		expect(evt?.event).toBe("message");
		expect(evt?.data).toBe("line1\nline2");
	});

	it("ignores comment lines (leading ':')", () => {
		const evt = parseSseBlock(": keep-alive\nevent: heartbeat\nid: h1\ndata: {}");
		expect(evt?.event).toBe("heartbeat");
		expect(evt?.id).toBe("h1");
	});

	it("returns undefined for an empty/comment-only block", () => {
		expect(parseSseBlock(": ping")).toBeUndefined();
	});
});
