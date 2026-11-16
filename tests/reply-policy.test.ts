import { describe, expect, it } from "vitest";
import { upstreamSilentPredicate } from "../src/reply-policy.js";

// The peer floor is older than the release that verifiably exports `isSilentReplyPayloadText`,
// so the plugin must pick its upstream predicate by what the host actually exports.

const tokenOnly = (text: string) => text === "NO_REPLY";
const widest = (text: string) => text.includes("NO_REPLY");

describe("upstreamSilentPredicate", () => {
	it("prefers the payload predicate when the host exports it", () => {
		const pick = upstreamSilentPredicate({
			isSilentReplyPayloadText: widest,
			isSilentReplyText: tokenOnly,
		});
		expect(pick("thinking:\nNO_REPLY")).toBe(true);
	});

	it("falls back to the token-only predicate when the host lacks the payload one", () => {
		const pick = upstreamSilentPredicate({ isSilentReplyText: tokenOnly });
		expect(pick("NO_REPLY")).toBe(true);
		expect(pick("thinking:\nNO_REPLY")).toBe(false);
	});
});
