import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted above the imports — the spy must exist first.
const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@rine-network/core")>();
	return { ...actual, probeReadability: probe };
});

import { PEEK_HEADER } from "@rine-network/core";
import type { Probe } from "@rine-network/core";
import { SETASIDE_SWEEP_INTERVAL_MS } from "../src/constants.js";
import { makeOnMessage } from "../src/dispatch.js";
import type { RineClient } from "../src/rine-client.js";
import { loadSetAside, recordSetAside, saveSetAside } from "../src/setaside.js";
import type { SetAsideReason } from "../src/setaside.js";
import type { RineConfig, RineInbound } from "../src/types.js";
import { logger, rineConfig } from "./helpers.js";

/** The one may-heal verdict these fixtures park, as the store now takes it. */
const SEALED: SetAsideReason = { kind: "sealed", groupId: "g-1", senderKeyId: "sk-1" };

/**
 * The readability gate in front of the agent turn.
 *
 * 🔴 What every arm here is really asserting: an unreadable message must reach a
 * terminal `true` WITHOUT being marked delivered. `false` means "dispatch failed,
 * hold the cursor" and `transports/sse.ts` freezes the resume point at the last
 * contiguously-delivered id — so a `false` here would pin the stream on a message
 * that will never open and replay from it on every restart. A mark-delivered here
 * is the original defect: it consumed the row out of `status=new`, `/poll` and the
 * SSE catch-up all at once, with no local copy anywhere.
 *
 * `probeReadability` is mocked because its own arms are `rine-core`'s tests; what
 * is under test is which arm does what to the inbox.
 */

const created: string[] = [];
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "rine-gate-"));
	created.push(dir);
	return dir;
}

function config(allowFrom: string[] = ["*"], over: Partial<RineConfig> = {}): RineConfig {
	return rineConfig({
		pollIntervalMs: 1000,
		reconnectBaseMs: 100,
		reconnectMaxMs: 1000,
		allowFrom,
		...over,
	});
}

function inbound(id: string, from = "alice@lab"): RineInbound {
	return {
		id,
		conversationId: `conv-${id}`,
		fromHandle: from,
		type: "rine.v1.group_post",
		isGroup: true,
		groupId: "g-1",
		encryptedPayload: "CIPHER",
		encryptionVersion: "sender-key-v1",
		fromAgentId: "agent-alice",
	};
}

/**
 * Every `makeOnMessage` starts the retry timer and binds it to this signal, so a
 * test that does not abort leaves an interval behind. Collected here and aborted
 * in `afterEach` — the same lifetime `service.ts` gives it.
 */
const running: AbortController[] = [];

function makeDeps(
	opts: {
		allowFrom?: string[];
		configDir?: string;
		config?: Partial<RineConfig>;
	} = {},
) {
	const dir = opts.configDir ?? tmp();
	const log = logger();
	const markDelivered = vi.fn(async () => 1);
	// 🔴 `client.client` and `client.configDir` are what the probe and the sweep
	// are handed. A stub with only `markDelivered` would let a gate that never
	// threads them read green.
	// Typed with the three arguments `HttpClient.get` really takes: the sweep's
	// peek header is an argument this file asserts on.
	const get = vi.fn<
		(
			path: string,
			params?: Record<string, unknown>,
			headers?: Record<string, string>,
		) => Promise<unknown>
	>(async () => {
		throw Object.assign(new Error("not found"), { status: 404 });
	});
	const client = {
		markDelivered,
		configDir: dir,
		client: { get },
	} as unknown as RineClient;
	const dispatch = vi.fn(async () => {});
	const controller = new AbortController();
	running.push(controller);
	const onMessage = makeOnMessage({
		client,
		config: config(opts.allowFrom, opts.config),
		agentId: "agent-1",
		logger: log,
		dispatch,
		signal: controller.signal,
	});
	return { onMessage, dispatch, markDelivered, log, dir, get, controller };
}

/**
 * Every verdict that must NOT reach the harness, and must not be acked, paired
 * with whether it is worth retrying.
 *
 * 🔴 The pairing is `rine-core`'s `isPermanent`, not this file's opinion — and
 * `mls-evicted` is why it is asked at all: no sync undoes a Remove, so the five
 * retries it used to get were five reads that could only return the same verdict.
 * A table rather than a boolean per test, so a new arm cannot be added without
 * someone answering the question.
 */
const UNREADABLE: Array<[Probe, boolean]> = [
	[{ kind: "no-keys" }, false],
	[{ kind: "sealed", groupId: "g-1", senderKeyId: "sk-1" }, false],
	[{ kind: "mls-recoverable", groupId: "g-1", err: new Error("commit") }, false],
	[{ kind: "mls-evicted", groupId: "g-1", err: new Error("inactive") }, true],
	[{ kind: "failed", groupId: "g-1", err: new Error("boom") }, false],
];

beforeEach(() => {
	probe.mockReset();
	probe.mockResolvedValue({ kind: "opened" });
});

afterEach(() => {
	for (const c of running.splice(0)) c.abort();
	for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readability gate — dispatchable verdicts", () => {
	it("dispatches and marks delivered when the envelope opens", async () => {
		const d = makeDeps();
		expect(await d.onMessage(inbound("m1"))).toBe(true);
		expect(d.dispatch).toHaveBeenCalledTimes(1);
		expect(d.markDelivered).toHaveBeenCalledWith("agent-1", ["m1"]);
		expect(loadSetAside(d.dir, "agent-1")).toEqual([]);
	});

	// The arm that keeps an A2A artifact (`encryption_version: "cleartext"`, no
	// authenticated sender) behaving exactly as it did before the gate existed.
	it("dispatches a payload that was never ciphertext this build opens", async () => {
		const d = makeDeps();
		probe.mockResolvedValue({ kind: "not-ciphertext" });
		expect(await d.onMessage(inbound("m1"))).toBe(true);
		expect(d.dispatch).toHaveBeenCalledTimes(1);
		expect(d.markDelivered).toHaveBeenCalledWith("agent-1", ["m1"]);
	});

	it("probes with this agent's own config dir and http client", async () => {
		const d = makeDeps();
		await d.onMessage(inbound("m1"));
		expect(probe).toHaveBeenCalledWith(
			expect.objectContaining({
				configDir: d.dir,
				agentId: "agent-1",
				groupId: "g-1",
				fromAgentId: "agent-alice",
				encryptedPayload: "CIPHER",
				encryptionVersion: "sender-key-v1",
				messageType: "rine.v1.group_post",
			}),
		);
		expect((probe.mock.calls[0]?.[0] as { client?: unknown }).client).toBeDefined();
	});
});

describe("readability gate — unreadable verdicts are set aside", () => {
	for (const [verdict, permanent] of UNREADABLE) {
		it(`sets aside a \`${verdict.kind}\` message without dispatching or acking it`, async () => {
			const d = makeDeps();
			probe.mockResolvedValue(verdict);
			// 🔴 `true`: handled, so the cursor may advance — never `false`, which
			// would pin the SSE stream on a message that cannot open.
			expect(await d.onMessage(inbound("m1"))).toBe(true);
			expect(d.dispatch).not.toHaveBeenCalled();
			// 🔴 Not acked, permanent or not: "stop retrying" is not "consume the
			// row". Only an authenticity refusal drains, and none of these is one.
			expect(d.markDelivered).not.toHaveBeenCalled();
			expect(loadSetAside(d.dir, "agent-1")).toMatchObject([
				{ id: "m1", reason: verdict.kind, attempts: 0, exhausted: permanent },
			]);
		});
	}

	// A permanent verdict is recorded already-exhausted, which used to be the
	// condition for staying silent — so the one message that will never be retried
	// would have been set aside without a word. The first sighting always speaks.
	it("says a permanent verdict will not be retried, on its first sighting", async () => {
		const d = makeDeps();
		probe.mockResolvedValue({ kind: "mls-evicted", groupId: "g-1", err: new Error("x") });
		await d.onMessage(inbound("m1"));
		const lines = (d.log.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("mls-evicted");
		expect(lines[0]).toContain("not retried");
		expect(d.markDelivered).not.toHaveBeenCalled();
	});

	it("says so in one INFO line naming the reason and the rine inbox", async () => {
		const d = makeDeps();
		probe.mockResolvedValue({ kind: "sealed", groupId: "g-1", senderKeyId: "sk-1" });
		await d.onMessage(inbound("m1"));
		const lines = (d.log.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("m1");
		expect(lines[0]).toContain("sealed");
		expect(lines[0]).toContain("rine inbox");
	});

	it("does not re-probe or re-log a set-aside message in the same session", async () => {
		const d = makeDeps();
		probe.mockResolvedValue({ kind: "sealed", groupId: "g-1", senderKeyId: "sk-1" });
		await d.onMessage(inbound("m1"));
		await d.onMessage(inbound("m1")); // poll tick — the row is still `status=new`
		expect(probe).toHaveBeenCalledTimes(1);
		expect(d.log.info).toHaveBeenCalledTimes(1);
	});

	// The store keeps `attempts` and `exhausted` across the hourly dedupe clear and
	// across a restart; a re-sighting must not reset either, and must not re-shout.
	it("stays quiet about an entry the sweep has already given up on", async () => {
		const dir = tmp();
		// Exhausted the way the sweep exhausts one — there is no verdict a caller
		// could pass to fake it, which is the point of taking the verdict.
		const { entry } = recordSetAside(dir, "agent-1", "m1", SEALED);
		saveSetAside(dir, "agent-1", [{ ...entry, attempts: 5, exhausted: true }]);
		const d = makeDeps({ configDir: dir });
		probe.mockResolvedValue({ kind: "sealed", groupId: "g-1", senderKeyId: "sk-1" });
		expect(await d.onMessage(inbound("m1"))).toBe(true);
		expect(d.log.info).not.toHaveBeenCalled();
		expect(d.markDelivered).not.toHaveBeenCalled();
		expect(loadSetAside(dir, "agent-1")[0]?.exhausted).toBe(true);
	});
});

describe("readability gate — an agent with no key material at all", () => {
	const NO_KEYS: Probe = { kind: "no-keys" };

	// 🔴 The gap this closes: every inbound message classifies `no-keys`, every one
	// is parked, no turn ever fires, and the only line said about it was the
	// ordinary set-aside INFO — which reads as routine, because for every other
	// verdict it is. The channel connected, reported healthy and never answered.
	it("says so at ERROR, naming the agent, the config dir and the key files", async () => {
		const d = makeDeps();
		probe.mockResolvedValue(NO_KEYS);
		await d.onMessage(inbound("m1"));
		const errors = (d.log.error as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
			String(c[0]),
		);
		expect(errors).toHaveLength(1);
		const line = errors[0] as string;
		// A line that names no agent and no directory diagnoses nothing — a host
		// can run several agents out of several config dirs.
		expect(line).toContain("agent-1");
		expect(line).toContain(d.dir);
		expect(line).toContain(`${d.dir}/keys/agent-1/signing.key`);
		expect(line).toContain("encryption.key");
		// And a remedy, which is the other half of diagnosing anything.
		expect(line).toContain("channels.rine.agentId");
		expect(line).toContain("rine_onboard");
	});

	// 🔴 The parking STAYS. Waking the harness instead would hand a model
	// ciphertext it cannot open, and a model handed that produces a confident
	// non-answer. What was missing was a signal, not a different action.
	it("still parks the message: no dispatch, no ack, still in the rine inbox", async () => {
		const d = makeDeps();
		probe.mockResolvedValue(NO_KEYS);
		expect(await d.onMessage(inbound("m1"))).toBe(true);
		expect(d.dispatch).not.toHaveBeenCalled();
		expect(d.markDelivered).not.toHaveBeenCalled();
		expect(loadSetAside(d.dir, "agent-1")).toMatchObject([
			{ id: "m1", reason: "no-keys", attempts: 0, exhausted: false },
		]);
		// The per-message INFO line is unchanged and still one per message.
		expect(d.log.info).toHaveBeenCalledTimes(1);
	});

	// 🔴 ONCE per agent, not once per message. A keyless agent receives *every*
	// message into this arm, so a per-message ERROR is exactly the log storm the
	// attempt bound exists to prevent.
	it("says it once however many messages arrive", async () => {
		const d = makeDeps();
		probe.mockResolvedValue(NO_KEYS);
		for (const id of ["m1", "m2", "m3", "m4", "m5"]) await d.onMessage(inbound(id));
		expect(d.log.error).toHaveBeenCalledTimes(1);
		// Five messages parked, one line about the install.
		expect(loadSetAside(d.dir, "agent-1")).toHaveLength(5);
		expect(d.log.info).toHaveBeenCalledTimes(5);
	});

	it("says nothing for a verdict that is about the message, not the install", async () => {
		const d = makeDeps();
		probe.mockResolvedValue({ kind: "sealed", groupId: "g-1", senderKeyId: "sk-1" });
		await d.onMessage(inbound("m1"));
		expect(d.log.error).not.toHaveBeenCalled();
	});

	// The latch belongs to the `onMessage` closure and not to the module, which is
	// what `service.ts` builds one of per notify loop per agent. So a second agent
	// cannot be silenced by the first one's line, and a restarted channel says it
	// again rather than staying quiet about a fault that is still there.
	it("says it again for a second channel over the same config dir", async () => {
		const dir = tmp();
		const a = makeDeps({ configDir: dir });
		const b = makeDeps({ configDir: dir });
		probe.mockResolvedValue(NO_KEYS);
		await a.onMessage(inbound("m1"));
		await b.onMessage(inbound("m2"));
		expect(a.log.error).toHaveBeenCalledTimes(1);
		expect(b.log.error).toHaveBeenCalledTimes(1);
	});
});

describe("readability gate — a refused envelope is permanent", () => {
	// 🔴 Authenticity is a property of the bytes: a forged signature never becomes
	// readable, so retrying it is waste AND a log amplifier whose cadence the
	// attacker picks. Drained exactly as it was before the gate existed.
	it("warns, drains the row, and records the refusal as already exhausted", async () => {
		const d = makeDeps();
		probe.mockResolvedValue({
			kind: "refused",
			verificationStatus: "sender-mismatch",
			result: null,
		});
		expect(await d.onMessage(inbound("m1"))).toBe(true);
		expect(d.dispatch).not.toHaveBeenCalled();
		expect(d.markDelivered).toHaveBeenCalledWith("agent-1", ["m1"]);
		expect(d.log.warn).toHaveBeenCalledWith(expect.stringContaining("refused message m1"));
		expect(loadSetAside(d.dir, "agent-1")).toMatchObject([
			{ id: "m1", reason: "refused", exhausted: true },
		]);
	});
});

describe("readability gate — ordering and cost", () => {
	it("does not probe a deduped replay", async () => {
		const d = makeDeps();
		await d.onMessage(inbound("m1"));
		await d.onMessage(inbound("m1"));
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("does not probe a quarantined sender (no crypto for a filtered message)", async () => {
		const d = makeDeps({ allowFrom: ["@acme"] });
		expect(await d.onMessage(inbound("m1", "mallory@evil"))).toBe(true);
		expect(probe).not.toHaveBeenCalled();
		expect(d.markDelivered).not.toHaveBeenCalled();
	});
});

describe("readability gate — the retry sweep it hangs off", () => {
	it("sweeps the durable list on the first inbound after a restart", async () => {
		const dir = tmp();
		recordSetAside(dir, "agent-1", "old-1", SEALED);
		const d = makeDeps({ configDir: dir });
		await d.onMessage(inbound("m1"));
		// The sweep peeked at the stored id; the 404 stub then forgets it.
		expect(d.get).toHaveBeenCalledWith(
			"/messages/old-1",
			undefined,
			expect.objectContaining({ [PEEK_HEADER]: "1" }),
		);
		expect(loadSetAside(dir, "agent-1")).toEqual([]);
	});

	// 🔴 The ordering half of this: the sweep used to run at the HEAD of
	// `onMessage`, so every inbound message waited behind up to a full list of
	// peeked reads and decrypt attempts before its own turn was dispatched.
	it("dispatches the live message BEFORE it retries anything", async () => {
		const dir = tmp();
		recordSetAside(dir, "agent-1", "old-1", SEALED);
		const d = makeDeps({ configDir: dir });
		await d.onMessage(inbound("m1"));
		expect(d.dispatch).toHaveBeenCalledTimes(1);
		expect(d.get).toHaveBeenCalledTimes(1);
		expect(d.dispatch.mock.invocationCallOrder[0] as number).toBeLessThan(
			d.get.mock.invocationCallOrder[0] as number,
		);
	});

	// 🔴 The half openclaw shipped without: with the sweep hung off `onMessage`, a
	// channel that received nothing retried nothing, however long it waited and
	// however many entries were sitting there ready to open. The automatic retry is
	// a chosen behaviour rather than a convenience on top of the on-demand verb, so
	// it has to ride a timer.
	it("sweeps on a timer with no inbound message at all", async () => {
		vi.useFakeTimers();
		try {
			const dir = tmp();
			recordSetAside(dir, "agent-1", "old-1", SEALED);
			const d = makeDeps({ configDir: dir });
			expect(d.get).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(SETASIDE_SWEEP_INTERVAL_MS);
			expect(d.get).toHaveBeenCalledWith(
				"/messages/old-1",
				undefined,
				expect.objectContaining({ [PEEK_HEADER]: "1" }),
			);
			// And it stops when the channel does, rather than outliving it.
			d.controller.abort();
			const after = d.get.mock.calls.length;
			await vi.advanceTimersByTimeAsync(SETASIDE_SWEEP_INTERVAL_MS * 3);
			expect(d.get.mock.calls.length).toBe(after);
		} finally {
			vi.useRealTimers();
		}
	});

	// 🔴 Asserted on the TIMER, never on the resolved config, because threading the
	// number is the part that can be dropped: `startSweepSchedule` defaults
	// `intervalMs` for the callers that build its args by hand, so a `dispatch.ts`
	// that forgets to pass the operator's value keeps every other test in this file
	// green while the knob does nothing. The cadence is the one of the four
	// set-aside bounds an operator can move — `hermes_rine` moves the same one, in
	// seconds, through the environment.
	it("sweeps on the interval the config asks for, not the built-in default", async () => {
		vi.useFakeTimers();
		try {
			const dir = tmp();
			recordSetAside(dir, "agent-1", "old-1", SEALED);
			const d = makeDeps({ configDir: dir, config: { setasideSweepIntervalMs: 5_000 } });
			await vi.advanceTimersByTimeAsync(4_000);
			expect(d.get).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(d.get).toHaveBeenCalledWith(
				"/messages/old-1",
				undefined,
				expect.objectContaining({ [PEEK_HEADER]: "1" }),
			);
			// This test's own validity: 5s has to be well inside the default, or it
			// would pass against a schedule that ignored the config entirely.
			expect(SETASIDE_SWEEP_INTERVAL_MS).toBeGreaterThan(5_000);
		} finally {
			vi.useRealTimers();
		}
	});

	// 🔴 The store outlives the process AND the config. An entry parked while
	// `allowFrom` was `*` must not be dispatched after the operator narrows it —
	// the gate is asked again on the retry path, not just on first sight.
	it("refuses to dispatch a healed message from a sender since disallowed", async () => {
		const dir = tmp();
		recordSetAside(dir, "agent-1", "old-1", SEALED);
		const d = makeDeps({ configDir: dir, allowFrom: ["@acme"] });
		d.get.mockResolvedValue({
			id: "old-1",
			conversation_id: "c",
			type: "rine.v1.group_post",
			encrypted_payload: "CIPHER",
			encryption_version: "sender-key-v1",
			created_at: "2026-09-11T00:00:00Z",
			sender_handle: "mallory@evil",
			from_agent_id: "agent-mallory",
			group_id: "g-1",
		});
		// The live message is from an allowed sender, so the tail sweep runs.
		expect(await d.onMessage(inbound("m1", "bob@acme"))).toBe(true);
		expect(d.get).toHaveBeenCalledTimes(1);
		// One dispatch — the live one. The healed retry was quarantined instead.
		expect(d.dispatch).toHaveBeenCalledTimes(1);
		expect(d.markDelivered).toHaveBeenCalledTimes(1);
		expect(d.markDelivered).toHaveBeenCalledWith("agent-1", ["m1"]);
		expect(d.log.warn).toHaveBeenCalledWith(
			expect.stringContaining('disallowed sender "mallory@evil"'),
		);
	});

	it("sweeps at most once per interval, however busy the stream is", async () => {
		const dir = tmp();
		recordSetAside(dir, "agent-1", "old-1", SEALED);
		recordSetAside(dir, "agent-1", "old-2", SEALED);
		const d = makeDeps({ configDir: dir });
		await d.onMessage(inbound("m1"));
		const afterFirst = d.get.mock.calls.length;
		expect(afterFirst).toBe(2);
		await d.onMessage(inbound("m2"));
		await d.onMessage(inbound("m3"));
		expect(d.get.mock.calls.length).toBe(afterFirst);
		// This test's own validity: three awaits must land inside one interval.
		expect(SETASIDE_SWEEP_INTERVAL_MS).toBeGreaterThan(1000);
	});

	it("keeps the live message when a retry read fails", async () => {
		const dir = tmp();
		recordSetAside(dir, "agent-1", "old-1", SEALED);
		const d = makeDeps({ configDir: dir });
		d.get.mockImplementation(async () => {
			throw new Error("gateway");
		});
		expect(await d.onMessage(inbound("m1"))).toBe(true);
		expect(d.dispatch).toHaveBeenCalledTimes(1);
		expect(d.markDelivered).toHaveBeenCalledWith("agent-1", ["m1"]);
		// The failed read counted as one attempt rather than vanishing.
		expect(loadSetAside(dir, "agent-1")[0]?.attempts).toBe(1);
	});

	// 🔴 An unusable config dir is the one input that can reach the store's own
	// path construction, and the whole sidecar layer must degrade to "absent"
	// rather than throw on it — an extraction that computed the path outside the
	// guard turned `loadCursor` into a throw on the SSE start path, caught only
	// by `expose.test.ts`. Built inline because `makeDeps` hands out a usable dir.
	it("degrades to no sweep — never a throw — on an unusable config dir", async () => {
		const log = logger();
		const markDelivered = vi.fn(async () => 1);
		const dispatch = vi.fn(async () => {});
		const onMessage = makeOnMessage({
			client: { markDelivered, client: {} } as unknown as RineClient,
			config: config(),
			agentId: "agent-1",
			logger: log,
			dispatch,
			signal: new AbortController().signal,
		});
		expect(await onMessage(inbound("m1"))).toBe(true);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(markDelivered).toHaveBeenCalledWith("agent-1", ["m1"]);
		expect(log.error).not.toHaveBeenCalled();
	});

	// Belt to the sweep's own braces. `probeReadability` never throws by contract,
	// so this is the contract being violated — and the property under test is that
	// a broken retry cannot cost the live message that triggered it.
	//
	// 🔴 The rejection is keyed on the retried row's OWN ciphertext, not on the
	// call order. The sweep runs after the live dispatch, so a mock sequenced
	// `mockRejectedValueOnce` first would break the live message and assert the
	// opposite of this test's name — and it would flip again the next time
	// anything about the ordering moves.
	it("keeps the live message when the sweep itself throws", async () => {
		const dir = tmp();
		recordSetAside(dir, "agent-1", "old-1", SEALED);
		const d = makeDeps({ configDir: dir });
		d.get.mockResolvedValue({
			id: "old-1",
			conversation_id: "c",
			type: "rine.v1.group_post",
			encrypted_payload: "CIPHER-OLD",
			encryption_version: "sender-key-v1",
			created_at: "2026-09-11T00:00:00Z",
			from_agent_id: "agent-alice",
			group_id: "g-1",
		});
		probe.mockImplementation(async (args: { encryptedPayload: string }) => {
			if (args.encryptedPayload === "CIPHER-OLD") throw new Error("probe exploded");
			return { kind: "opened" };
		});
		expect(await d.onMessage(inbound("m1"))).toBe(true);
		expect(d.log.warn).toHaveBeenCalledWith(expect.stringContaining("sweep failed"));
		expect(d.dispatch).toHaveBeenCalledTimes(1);
		expect(d.markDelivered).toHaveBeenCalledWith("agent-1", ["m1"]);
	});
});
