import { UNOPENED_VERDICT } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { wakeSender } from "../src/wake-identity.js";
import type { RineInbound } from "../src/types.js";

const SEAT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const OTHER_ID = "c3d4e5f6-a7b8-9012-cdef-123456789012";
const PIN = { agentId: SEAT_ID, signingKey: "c2lnbmluZy1rZXk" };

function from(fromHandle: string): RineInbound {
	return { fromHandle, fromAgentId: OTHER_ID } as RineInbound;
}

describe("the sender a wake line names for someone who is not the operator", () => {
	it("test_wake_sender_when_a_handle_equals_the_pinned_seat_handle_then_the_agent_id_is_shown", () => {
		const pin = { ...PIN, handle: "console@acme.rine.network" };

		const sender = wakeSender(from("Console@acme.rine.network"), UNOPENED_VERDICT, pin);

		expect(sender).toEqual({ id: OTHER_ID, label: OTHER_ID });
	});

	it("test_wake_sender_when_the_pinned_seat_handle_is_long_or_outside_the_handle_set_then_it_still_matches", () => {
		const long = `console${"a".repeat(200)}@acme.rine.network`;
		const odd = "con sole@acme.rine.network";

		const longSender = wakeSender(from(long), UNOPENED_VERDICT, { ...PIN, handle: long });
		const oddSender = wakeSender(from(odd), UNOPENED_VERDICT, { ...PIN, handle: odd });

		expect(longSender.id).toBe(OTHER_ID);
		expect(oddSender.id).toBe(OTHER_ID);
	});

	it("test_wake_sender_when_the_pin_has_no_handle_then_a_non_ops_handle_is_shown", () => {
		const sender = wakeSender(from("console@acme.rine.network"), UNOPENED_VERDICT, PIN);

		expect(sender.id).toBe("console@acme.rine.network");
	});

	it("test_wake_sender_when_the_pin_has_no_handle_then_an_ops_handle_shows_the_agent_id", () => {
		const sender = wakeSender(from("ops@elsewhere.rine.network"), UNOPENED_VERDICT, PIN);

		expect(sender.id).toBe(OTHER_ID);
	});

	it("test_wake_sender_when_no_pin_is_configured_then_the_handle_is_shown", () => {
		const sender = wakeSender(from("ops@elsewhere.rine.network"), UNOPENED_VERDICT, null);

		expect(sender.id).toBe("ops@elsewhere.rine.network");
	});
});
