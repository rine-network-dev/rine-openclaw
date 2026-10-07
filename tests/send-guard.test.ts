import { describe, expect, it } from "vitest";
import {
	SEND_GUARD_MAX_RUNS,
	SEND_GUARD_RUN_TTL_MS,
	alreadySentText,
	createSendGuard,
} from "../src/send-guard.js";

const send = { to: "ops@mine.rine.network", payload: { text: "hi" } };

describe("send guard", () => {
	it("allows the first send and blocks an identical repeat in the same run", () => {
		const guard = createSendGuard();
		expect(guard.check("run-1", "rine_send", send)).toMatchObject({ block: false });
		expect(guard.check("run-1", "rine_send", send)).toEqual({
			block: true,
			reason: alreadySentText("ops@mine.rine.network"),
		});
	});

	it("blocks every repeat, not only the second call", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_send", send);
		for (let i = 0; i < 23; i++) {
			expect(guard.check("run-1", "rine_send", send)?.block).toBe(true);
		}
	});

	it("allows the same message in a different run", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_send", send);
		expect(guard.check("run-2", "rine_send", send)).toMatchObject({ block: false });
	});

	it("allows a different message to the same recipient in the same run", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_send", send);
		expect(guard.check("run-1", "rine_send", { ...send, payload: { text: "another" } })).toMatchObject({ block: false });
	});

	it("collapses parallel identical calls: the second sees the first before anything awaits", () => {
		const guard = createSendGuard();
		const verdicts = [guard.check("run-1", "rine_send", send), guard.check("run-1", "rine_send", send)];
		expect(verdicts.map((v) => v?.block)).toEqual([false, true]);
	});

	it("ignores idempotency_key when comparing calls", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_send", { ...send, idempotency_key: "k-1" });
		expect(guard.check("run-1", "rine_send", { ...send, idempotency_key: "k-2" })?.block).toBe(true);
		expect(guard.check("run-1", "rine_send", send)?.block).toBe(true);
	});

	it("ignores object key order at every depth", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_send", { to: "a@b", payload: { x: 1, y: { p: 1, q: 2 } } });
		expect(guard.check("run-1", "rine_send", { payload: { y: { q: 2, p: 1 }, x: 1 }, to: "a@b" })?.block).toBe(true);
	});

	it("keeps rine_send and rine_send_and_wait apart", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_send", send);
		expect(guard.check("run-1", "rine_send_and_wait", send)).toMatchObject({ block: false });
		expect(guard.check("run-1", "rine_send_and_wait", send)?.block).toBe(true);
	});

	it("lets the identical retry through after the first send failed", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_send", send, undefined, "call-1");
		guard.settle("run-1", "call-1", true);
		expect(guard.check("run-1", "rine_send", send, undefined, "call-2")).toMatchObject({ block: false });
	});

	it("keeps blocking parallel duplicates while the first send is still pending", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_send", send, undefined, "call-1");
		expect(guard.check("run-1", "rine_send", send, undefined, "call-2")?.block).toBe(true);
		expect(guard.check("run-1", "rine_send", send, undefined, "call-3")?.block).toBe(true);
	});

	it("keeps blocking the repeat once the first send succeeded", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_send", send, undefined, "call-1");
		guard.settle("run-1", "call-1", false);
		expect(guard.check("run-1", "rine_send", send, undefined, "call-2")?.block).toBe(true);
	});

	it("does not release the first send's key when a blocked duplicate settles as failed", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_send", send, undefined, "call-1");
		guard.check("run-1", "rine_send", send, undefined, "call-2");
		guard.settle("run-1", "call-2", true);
		expect(guard.check("run-1", "rine_send", send, undefined, "call-3")?.block).toBe(true);
	});

	it("ignores a settle for a run or call it never saw", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_send", send, undefined, "call-1");
		guard.settle("run-2", "call-1", true);
		guard.settle("run-1", "call-9", true);
		expect(guard.check("run-1", "rine_send", send, undefined, "call-2")?.block).toBe(true);
	});

	it("leaves a failed send blocked when the call carried no id to settle it by", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_send", send);
		guard.settle("run-1", "call-1", true);
		expect(guard.check("run-1", "rine_send", send)?.block).toBe(true);
	});

	it("forgets a run's pending calls with the run, so a stale settle cannot release a later call", () => {
		let now = 1_000_000;
		const guard = createSendGuard(() => now);
		guard.check("run-1", "rine_send", send, undefined, "call-1");
		now += SEND_GUARD_RUN_TTL_MS + 1;
		guard.check("run-2", "rine_send", { ...send, to: "someone@else" }); // sweeps run-1
		expect(guard.check("run-1", "rine_send", send, undefined, "call-2")).toMatchObject({ block: false });
		guard.settle("run-1", "call-1", true);
		expect(guard.check("run-1", "rine_send", send, undefined, "call-3")?.block).toBe(true);
	});

	it("derives one idempotency key per run and message, kept when the call is released and retried", () => {
		const guard = createSendGuard();
		const first = guard.check("run-1", "rine_send", send, undefined, "call-1");
		guard.settle("run-1", "call-1", true);
		const retry = guard.check("run-1", "rine_send", send, undefined, "call-2");
		expect(first).toMatchObject({ block: false, idempotencyKey: expect.stringMatching(/^rine-oc-/) });
		expect(retry).toEqual(first);
		const other = guard.check("run-1", "rine_send", { ...send, payload: { text: "another" } });
		const later = guard.check("run-2", "rine_send", send);
		expect(new Set([first, other, later].map((v) => v && !v.block && v.idempotencyKey)).size).toBe(3);
	});

	it("keeps the model's own idempotency key, and holds a released retry to the first key it sent", () => {
		const guard = createSendGuard();
		expect(guard.check("run-1", "rine_send", { ...send, idempotency_key: "k-1" }, undefined, "call-1")).toEqual({
			block: false,
			idempotencyKey: "k-1",
		});
		guard.settle("run-1", "call-1", true);
		expect(guard.check("run-1", "rine_send", { ...send, idempotency_key: "k-2" })).toEqual({
			block: false,
			idempotencyKey: "k-1",
		});
	});

	it("derives a key instead of pinning a model key the server or fetch would refuse", () => {
		const guard = createSendGuard();
		for (const [i, bad] of ["x".repeat(256), "line\nbreak", "caf\u00e9", " edge", "edge ", ""].entries()) {
			const verdict = guard.check(`run-${i}`, "rine_send", { ...send, idempotency_key: bad });
			expect(verdict).toMatchObject({ block: false, idempotencyKey: expect.stringMatching(/^rine-oc-/) });
		}
		const long = "x".repeat(255);
		expect(guard.check("run-ok", "rine_send", { ...send, idempotency_key: long })).toEqual({
			block: false,
			idempotencyKey: long,
		});
		expect(guard.check("run-sp", "rine_send", { ...send, idempotency_key: "invoice 1042" })).toEqual({
			block: false,
			idempotencyKey: "invoice 1042",
		});
	});

	it("keeps the derived key pinned when a released retry supplies a corrected key", () => {
		const guard = createSendGuard();
		const first = guard.check("run-1", "rine_send", { ...send, idempotency_key: "x".repeat(300) }, undefined, "call-1");
		guard.settle("run-1", "call-1", true);
		const retry = guard.check("run-1", "rine_send", { ...send, idempotency_key: "k-1" });
		expect(retry).toEqual(first);
	});

	it("never blocks a tool it does not guard", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_inbox", {});
		expect(guard.check("run-1", "rine_inbox", {})).toBeUndefined();
		guard.check("run-1", "rine_pay", { to: "a@b" });
		expect(guard.check("run-1", "rine_pay", { to: "a@b" })).toBeUndefined();
	});

	it("tells the model the send happened and that it must stop, without naming an error", () => {
		const text = alreadySentText("ops@mine.rine.network");
		expect(text).toBe(
			"Already sent: this exact message to ops@mine.rine.network went out earlier in this turn. " +
				"It was not sent again. Do not send it again; finish your turn.",
		);
		expect(alreadySentText(undefined)).toContain("to that recipient went out");
	});

	it("forgets a session's runs when the session ends", () => {
		const guard = createSendGuard();
		guard.check("run-1", "rine_send", send, "agent:main:main");
		guard.check("run-2", "rine_send", send, "agent:other:main");
		guard.forgetSession("agent:main:main");
		expect(guard.check("run-1", "rine_send", send, "agent:main:main")).toMatchObject({ block: false });
		expect(guard.check("run-2", "rine_send", send, "agent:other:main")?.block).toBe(true);
	});

	it("forgets a run that has been idle past the TTL, with no end-of-run signal needed", () => {
		let now = 1_000_000;
		const guard = createSendGuard(() => now);
		guard.check("run-1", "rine_send", send);
		now += SEND_GUARD_RUN_TTL_MS + 1;
		guard.check("run-2", "rine_send", { ...send, to: "someone@else" }); // any later call sweeps
		expect(guard.check("run-1", "rine_send", send)).toMatchObject({ block: false });
	});

	it("keeps a run alive while it keeps calling", () => {
		let now = 1_000_000;
		const guard = createSendGuard(() => now);
		guard.check("run-1", "rine_send", send);
		now += SEND_GUARD_RUN_TTL_MS - 1;
		guard.check("run-1", "rine_send", send);
		now += SEND_GUARD_RUN_TTL_MS - 1;
		expect(guard.check("run-1", "rine_send", send)?.block).toBe(true);
	});

	it("bounds the tracked runs, dropping the least recently used first", () => {
		const guard = createSendGuard();
		for (let i = 0; i < SEND_GUARD_MAX_RUNS + 1; i++) guard.check(`run-${i}`, "rine_send", send);
		guard.check("run-late", "rine_send", send); // sweep runs before the insert, so it settles at the cap
		expect(guard.check("run-0", "rine_send", send)).toMatchObject({ block: false });
		expect(guard.check(`run-${SEND_GUARD_MAX_RUNS}`, "rine_send", send)?.block).toBe(true);
	});
});
