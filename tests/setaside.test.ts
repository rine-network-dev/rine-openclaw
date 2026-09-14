import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted above the imports — the spy must exist first.
const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));

// Only `probeReadability` is replaced: the two header constants the sweep puts on
// the wire are asserted here, so they must be the REAL ones. A local copy of
// `X-Rine-Peek` would make this file agree with itself and with nothing else.
vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@rine-network/core")>();
	return { ...actual, probeReadability: probe };
});

import { ACTING_AGENT_HEADER, PEEK_HEADER } from "@rine-network/core";
import type { HttpClient, MessageRead, Probe } from "@rine-network/core";
import {
	SETASIDE_MAX_ATTEMPTS,
	SETASIDE_MAX_ENTRIES,
	SETASIDE_SWEEP_BATCH,
	SETASIDE_SWEEP_INTERVAL_MS,
} from "../src/constants.js";
import {
	dropSetAside,
	isDispatchable,
	loadSetAside,
	recordSetAside,
	saveSetAside,
} from "../src/setaside.js";
import type { SetAsideEntry, SetAsideReason } from "../src/setaside.js";
import { sweepSetAside } from "../src/setaside-sweep.js";
import type { RineInbound } from "../src/types.js";
import { logger } from "./helpers.js";

const created: string[] = [];
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "rine-setaside-"));
	created.push(dir);
	return dir;
}

function row(id: string, over: Partial<MessageRead> = {}): MessageRead {
	return {
		id,
		conversation_id: `conv-${id}`,
		sender_handle: "alice@lab",
		from_agent_id: "agent-alice",
		type: "rine.v1.group_post",
		encrypted_payload: "CIPHER",
		encryption_version: "sender-key-v1",
		created_at: "2026-09-11T00:00:00Z",
		group_id: "g-1",
		...over,
	};
}

/**
 * The verdicts, as the objects the store now takes.
 *
 * 🔴 It takes the VERDICT rather than a `kind` string beside a `permanent`
 * boolean, so a test cannot assert a permanence the product would not derive —
 * which is what the old fixtures did, passing `false` for `mls-evicted` beside a
 * classifier documenting that no sync undoes a Remove.
 */
const SEALED: SetAsideReason = { kind: "sealed", groupId: "g-1", senderKeyId: "sk-1" };
const NO_KEYS: SetAsideReason = { kind: "no-keys" };
const REFUSED: SetAsideReason = {
	kind: "refused",
	verificationStatus: "invalid",
	result: null,
};
const EVICTED: SetAsideReason = {
	kind: "mls-evicted",
	groupId: "g-1",
	err: new Error("group inactive"),
};

/** The three-argument shape `HttpClient.get` really has — the headers matter here. */
type Get = (
	path: string,
	params?: Record<string, unknown>,
	headers?: Record<string, string>,
) => Promise<unknown>;

/** A sweep rig: a client whose `get` is scripted, and a recording `deliver`. */
function rig(opts: { get?: Get } = {}) {
	const dir = tmp();
	const log = logger();
	const get = vi.fn<Get>(
		opts.get ?? (async (p: string) => row(p.split("/").pop() as string)),
	);
	const delivered: RineInbound[] = [];
	const seenAtDeliver: SetAsideEntry[][] = [];
	const deliver = vi.fn(async (msg: RineInbound) => {
		// Captures the store AS IT STANDS during dispatch — the drop-before-deliver
		// ordering is only observable from in here.
		seenAtDeliver.push(loadSetAside(dir, "agent-1", log));
		delivered.push(msg);
		return true;
	});
	const args = {
		client: { get } as unknown as HttpClient,
		configDir: dir,
		agentId: "agent-1",
		logger: log,
		deliver,
	};
	return { dir, log, get, deliver, delivered, seenAtDeliver, args };
}

beforeEach(() => {
	probe.mockReset();
	probe.mockResolvedValue({ kind: "sealed", groupId: "g-1", senderKeyId: "sk-1" });
});

afterEach(() => {
	for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("isDispatchable", () => {
	// The one spelling of "does this go to the harness" — both the dispatch gate
	// and the sweep narrow off it, so each arm is pinned by name.
	it("admits exactly `opened` and `not-ciphertext`", () => {
		expect(isDispatchable({ kind: "opened" } as Probe)).toBe(true);
		expect(isDispatchable({ kind: "not-ciphertext" } as Probe)).toBe(true);
	});

	it("refuses every unreadable verdict", () => {
		const unreadable: Probe[] = [
			{ kind: "no-keys" },
			{ kind: "sealed", groupId: "g", senderKeyId: "sk" },
			{ kind: "mls-recoverable", groupId: "g", err: new Error("x") },
			{ kind: "mls-evicted", groupId: "g", err: new Error("x") },
			{ kind: "refused", verificationStatus: "invalid", result: null },
			{ kind: "failed", groupId: null, err: new Error("x") },
		];
		for (const v of unreadable) expect(isDispatchable(v)).toBe(false);
	});
});

describe("set-aside bounds", () => {
	// 🔴 One policy, two connectors, one server. `hermes_rine._setaside` runs
	// `SETASIDE_MAX_ROWS = 500`, `SETASIDE_MAX_ATTEMPTS = 5`,
	// `SETASIDE_SWEEP_BATCH = 50` and a 300-second sweep interval. Three of the
	// four were identical from the start; the capacity was not, and nothing in
	// either tree gave a reason for the difference.
	//
	// Pinned as a block, and with the numbers written out, because this is the
	// only gate that binds them: nothing here can read the Python constants — the
	// rig this suite runs in mounts this package and its two npm siblings, and
	// `rine-hermes` is not among them — so the alternative to four literals is no
	// check at all. A change to one of these is a decision about both connectors.
	it("match hermes_rine's, number for number", () => {
		expect(SETASIDE_MAX_ENTRIES).toBe(500);
		expect(SETASIDE_MAX_ATTEMPTS).toBe(5);
		expect(SETASIDE_SWEEP_BATCH).toBe(50);
		expect(SETASIDE_SWEEP_INTERVAL_MS).toBe(300_000);
	});
});

describe("set-aside store", () => {
	it("round-trips an entry and reports it oldest-first", () => {
		const dir = tmp();
		recordSetAside(dir, "agent-1", "m1", SEALED);
		recordSetAside(dir, "agent-1", "m2", NO_KEYS);
		expect(loadSetAside(dir, "agent-1").map((e) => e.id)).toEqual(["m1", "m2"]);
		const [first] = loadSetAside(dir, "agent-1");
		expect(first).toMatchObject({
			id: "m1",
			reason: "sealed",
			attempts: 0,
			lastTried: null,
			exhausted: false,
		});
	});

	// The bound counts RETRIES, not sightings: the in-session dedupe Set is cleared
	// hourly and lost on restart, so a still-unreadable row lands here repeatedly.
	// If a re-record counted, a quiet agent would exhaust its own retries by polling.
	it("re-records idempotently: attempts and firstSeen survive, nothing is duplicated", () => {
		const dir = tmp();
		const { entry: first, firstSighting } = recordSetAside(dir, "agent-1", "m1", SEALED);
		expect(firstSighting).toBe(true);
		saveSetAside(dir, "agent-1", [{ ...first, attempts: 3, lastTried: 111 }]);
		const again = recordSetAside(dir, "agent-1", "m1", SEALED);
		expect(again.entry.attempts).toBe(3);
		expect(again.entry.lastTried).toBe(111);
		expect(again.entry.firstSeen).toBe(first.firstSeen);
		expect(loadSetAside(dir, "agent-1")).toHaveLength(1);
		// 🔴 The second sighting is NOT a first sighting, which is the only thing
		// that tells the caller's log line apart from a repeat.
		expect(again.firstSighting).toBe(false);
	});

	it("keeps `exhausted` sticky — another sighting never re-arms a give-up", () => {
		const dir = tmp();
		recordSetAside(dir, "agent-1", "m1", REFUSED);
		expect(recordSetAside(dir, "agent-1", "m1", REFUSED).entry.exhausted).toBe(true);
		expect(loadSetAside(dir, "agent-1")[0]?.exhausted).toBe(true);
	});

	// 🔴 Permanence is `rine-core`'s answer, not this store's opinion and not the
	// caller's argument: there is no longer a boolean a call site could get wrong.
	// `mls-evicted` is the arm that proves it is being ASKED — no sync undoes a
	// Remove, so retrying it five times was five futile reads.
	it("records a permanent verdict already exhausted, and a may-heal one live", () => {
		const dir = tmp();
		recordSetAside(dir, "agent-1", "forged", REFUSED);
		recordSetAside(dir, "agent-1", "evicted", EVICTED);
		recordSetAside(dir, "agent-1", "sealed", SEALED);
		recordSetAside(dir, "agent-1", "nokeys", NO_KEYS);
		const byId = new Map(loadSetAside(dir, "agent-1").map((e) => [e.id, e.exhausted]));
		expect([...byId]).toEqual([
			["forged", true],
			["evicted", true],
			["sealed", false],
			["nokeys", false],
		]);
	});

	it("drops one entry and leaves the others", () => {
		const dir = tmp();
		recordSetAside(dir, "agent-1", "m1", SEALED);
		recordSetAside(dir, "agent-1", "m2", SEALED);
		dropSetAside(dir, "agent-1", "m1");
		expect(loadSetAside(dir, "agent-1").map((e) => e.id)).toEqual(["m2"]);
	});

	it("evicts the oldest EXHAUSTED entry before any live one on overflow", () => {
		const dir = tmp();
		const entries: SetAsideEntry[] = [];
		// Oldest two are live, the third is exhausted — so a purely-oldest-first
		// eviction would take a live entry and lose it a retry that could still work.
		for (let i = 0; i < SETASIDE_MAX_ENTRIES + 1; i += 1) {
			entries.push({
				id: `m${i}`,
				reason: "sealed",
				attempts: 0,
				firstSeen: 1000 + i,
				lastTried: null,
				exhausted: i === 2,
			});
		}
		saveSetAside(dir, "agent-1", entries);
		const kept = loadSetAside(dir, "agent-1").map((e) => e.id);
		expect(kept).toHaveLength(SETASIDE_MAX_ENTRIES);
		expect(kept).not.toContain("m2");
		expect(kept).toContain("m0");
		expect(kept).toContain("m1");
	});

	it("falls back to the oldest entry when nothing is exhausted", () => {
		const dir = tmp();
		saveSetAside(
			dir,
			"agent-1",
			Array.from({ length: SETASIDE_MAX_ENTRIES + 1 }, (_, i) => ({
				id: `m${i}`,
				reason: "sealed" as const,
				attempts: 0,
				firstSeen: 1000 + i,
				lastTried: null,
				exhausted: false,
			})),
		);
		const kept = loadSetAside(dir, "agent-1").map((e) => e.id);
		expect(kept).toHaveLength(SETASIDE_MAX_ENTRIES);
		expect(kept).not.toContain("m0");
	});

	it("degrades to an empty list (never throws) on a corrupt file", () => {
		const dir = tmp();
		recordSetAside(dir, "agent-1", "m1", SEALED);
		const [file] = readdirSync(dir);
		writeFileSync(join(dir, file as string), "{not json");
		const log = logger();
		expect(loadSetAside(dir, "agent-1", log)).toEqual([]);
		expect(log.debug).toHaveBeenCalled();
	});

	it("keeps the well-formed entries out of a partially-corrupt list", () => {
		const dir = tmp();
		recordSetAside(dir, "agent-1", "m1", SEALED);
		const [file] = readdirSync(dir);
		const good = loadSetAside(dir, "agent-1")[0] as SetAsideEntry;
		writeFileSync(
			join(dir, file as string),
			JSON.stringify([good, { id: "m2" }, null, 7, { ...good, id: "" }]),
		);
		expect(loadSetAside(dir, "agent-1").map((e) => e.id)).toEqual(["m1"]);
	});

	it("writes 0600 and never escapes configDir for a traversal-shaped agentId", () => {
		const dir = tmp();
		recordSetAside(dir, "../../etc/evil", "m1", SEALED);
		expect(loadSetAside(dir, "../../etc/evil").map((e) => e.id)).toEqual(["m1"]);
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		expect(statSync(join(dir, files[0] as string)).mode & 0o777).toBe(0o600);
	});

	// 🔴 The sidecar layer degrades to "absent" on EVERY failure, path
	// construction included. `join` throws on a non-string, so computing the path
	// outside the guard turns a best-effort read into a throw on the inbound path
	// — which is exactly what the `cursor.ts` extraction did until it was caught.
	it("degrades instead of throwing on an unusable config dir", () => {
		const bad = undefined as unknown as string;
		expect(() => loadSetAside(bad, "agent-1")).not.toThrow();
		expect(loadSetAside(bad, "agent-1")).toEqual([]);
		expect(() => recordSetAside(bad, "agent-1", "m1", SEALED)).not.toThrow();
		expect(() => dropSetAside(bad, "agent-1", "m1")).not.toThrow();
	});

	it("keeps per-agent lists independent in one dir", () => {
		const dir = tmp();
		recordSetAside(dir, "agent-a", "m-a", SEALED);
		recordSetAside(dir, "agent-b", "m-b", NO_KEYS);
		expect(loadSetAside(dir, "agent-a").map((e) => e.id)).toEqual(["m-a"]);
		expect(loadSetAside(dir, "agent-b").map((e) => e.id)).toEqual(["m-b"]);
	});
});

describe("set-aside retry sweep", () => {
	it("re-reads with the acting-agent AND peek headers", async () => {
		const r = rig();
		recordSetAside(r.dir, "agent-1", "m1", SEALED);
		await sweepSetAside(r.args);
		expect(r.get).toHaveBeenCalledWith("/messages/m1", undefined, {
			[ACTING_AGENT_HEADER]: "agent-1",
			[PEEK_HEADER]: "1",
		});
	});

	// 🔴 The whole point: without peek the retry read would consume the very row
	// the store exists to protect, and the second failure would destroy it.
	it("peeks on EVERY retry, including the one that stays unreadable", async () => {
		const r = rig();
		recordSetAside(r.dir, "agent-1", "m1", SEALED);
		await sweepSetAside(r.args);
		await sweepSetAside(r.args);
		for (const call of r.get.mock.calls) {
			expect((call[2] as Record<string, string>)[PEEK_HEADER]).toBe("1");
		}
	});

	it("delivers an entry that now opens, and forgets it FIRST", async () => {
		const r = rig();
		recordSetAside(r.dir, "agent-1", "m1", SEALED);
		probe.mockResolvedValue({ kind: "opened" });
		await sweepSetAside(r.args);
		expect(r.delivered.map((m) => m.id)).toEqual(["m1"]);
		// Observed from inside `deliver`: a crash mid-dispatch must lose the turn
		// (the row is still `new`), never re-run one — the dedupe Set is in memory.
		expect(r.seenAtDeliver[0]).toEqual([]);
		expect(loadSetAside(r.dir, "agent-1")).toEqual([]);
		expect(r.log.info).toHaveBeenCalledWith(expect.stringContaining("opened on retry 1"));
	});

	it("counts one attempt and keeps the entry when it is still unreadable", async () => {
		const r = rig();
		recordSetAside(r.dir, "agent-1", "m1", SEALED);
		await sweepSetAside(r.args);
		expect(r.deliver).not.toHaveBeenCalled();
		const [entry] = loadSetAside(r.dir, "agent-1");
		expect(entry?.attempts).toBe(1);
		expect(entry?.lastTried).toBeTypeOf("number");
		expect(entry?.exhausted).toBe(false);
	});

	it("gives up after SETASIDE_MAX_ATTEMPTS, says so once, and stops re-reading", async () => {
		const r = rig();
		recordSetAside(r.dir, "agent-1", "m1", SEALED);
		for (let i = 0; i < SETASIDE_MAX_ATTEMPTS; i += 1) await sweepSetAside(r.args);
		expect(r.get).toHaveBeenCalledTimes(SETASIDE_MAX_ATTEMPTS);
		const [entry] = loadSetAside(r.dir, "agent-1");
		expect(entry?.attempts).toBe(SETASIDE_MAX_ATTEMPTS);
		expect(entry?.exhausted).toBe(true);
		// 🔴 Still listed and still in the rine inbox — the row was never acked.
		const warns = (r.log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
		const giveUp = warns.filter((w) => w.includes("no longer retried"));
		expect(giveUp).toHaveLength(1);
		expect(giveUp[0]).toContain("rine_inbox");
		// Exhausted: the next sweep must not read it again.
		await sweepSetAside(r.args);
		expect(r.get).toHaveBeenCalledTimes(SETASIDE_MAX_ATTEMPTS);
	});

	it("forgets an entry whose row is gone (404), without delivering it", async () => {
		const r = rig({
			get: async () => {
				throw Object.assign(new Error("not found"), { status: 404 });
			},
		});
		recordSetAside(r.dir, "agent-1", "m1", SEALED);
		await sweepSetAside(r.args);
		expect(loadSetAside(r.dir, "agent-1")).toEqual([]);
		expect(r.deliver).not.toHaveBeenCalled();
	});

	it("counts a transport failure as an attempt and keeps the entry", async () => {
		const r = rig({
			get: async () => {
				throw Object.assign(new Error("gateway"), { status: 502 });
			},
		});
		recordSetAside(r.dir, "agent-1", "m1", SEALED);
		await sweepSetAside(r.args);
		expect(loadSetAside(r.dir, "agent-1")[0]?.attempts).toBe(1);
	});

	it("does nothing at all — no read, no log — when the list is empty", async () => {
		const r = rig();
		await sweepSetAside(r.args);
		expect(r.get).not.toHaveBeenCalled();
		expect(r.log.debug).not.toHaveBeenCalled();
	});

	// 🔴 This is the one case where the drop-before-deliver ordering could lose the
	// entry for good: `deliver` reports a failed agent turn as `false` rather than
	// throwing, and by then the entry is gone. The row is still unmarked on the
	// server, but "unmarked" only brings it back by itself on the `poll` transport —
	// on the default `sse` one the cursor has already advanced past the id, so
	// without the re-park this entry is the last automatic route to the message and
	// its whole reason for being set aside goes with it.
	it("re-parks the entry, one attempt spent, when the agent turn itself fails", async () => {
		const r = rig();
		r.deliver.mockResolvedValue(false);
		recordSetAside(r.dir, "agent-1", "m1", SEALED);
		probe.mockResolvedValue({ kind: "opened" });
		await expect(sweepSetAside(r.args)).resolves.toBeUndefined();
		expect(loadSetAside(r.dir, "agent-1")).toMatchObject([
			{ id: "m1", reason: "sealed", attempts: 1, exhausted: false },
		]);
	});

	// The re-park must not become a loop: a harness that fails EVERY dispatch spends
	// the same bound as a message that never opens, which is why the attempt count
	// has to survive the drop rather than restart from zero.
	it("still exhausts when every dispatch of a healed message fails", async () => {
		const r = rig();
		r.deliver.mockResolvedValue(false);
		recordSetAside(r.dir, "agent-1", "m1", SEALED);
		probe.mockResolvedValue({ kind: "opened" });
		for (let i = 0; i < SETASIDE_MAX_ATTEMPTS + 2; i += 1) await sweepSetAside(r.args);
		expect(r.deliver).toHaveBeenCalledTimes(SETASIDE_MAX_ATTEMPTS);
		const [entry] = loadSetAside(r.dir, "agent-1");
		expect(entry?.attempts).toBe(SETASIDE_MAX_ATTEMPTS);
		expect(entry?.exhausted).toBe(true);
		const warns = (r.log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
		expect(warns.filter((w) => w.includes("no longer retried"))).toHaveLength(1);
		// The give-up line names the dispatch as the cause, not the original reason
		// alone — "sealed" on its own would send an operator looking for a key.
		expect(warns.find((w) => w.includes("no longer retried"))).toContain("dispatch failed");
	});

	// 🔴 Permanence can be reached BETWEEN sightings, and it used to be honoured on
	// one end of the entry's life only: `recordSetAside` asks `isPermanent` on a
	// first sighting, and the sweep threw its own verdict away. A message sealed
	// while its sender key was merely missing, then hit by a Remove, therefore spent
	// all five attempts — five peeked reads and five group syncs over twenty minutes
	// — on a verdict that answered the question at the first one.
	it("retires an entry the moment its verdict turns permanent, without spending the bound", async () => {
		const r = rig();
		recordSetAside(r.dir, "agent-1", "m1", SEALED);
		expect(loadSetAside(r.dir, "agent-1")[0]?.exhausted).toBe(false);
		probe.mockResolvedValue(EVICTED);
		await sweepSetAside(r.args);
		expect(loadSetAside(r.dir, "agent-1")).toMatchObject([
			{ id: "m1", attempts: 1, exhausted: true },
		]);
		// And it stops costing reads, which is the whole point of retiring it.
		await sweepSetAside(r.args);
		expect(r.get).toHaveBeenCalledTimes(1);
		expect(r.deliver).not.toHaveBeenCalled();
	});

	// The stored reason is what the give-up line reports and what `groupSyncMayHeal`
	// reads next sweep, so a stale one is both a misleading log and a pointless sync.
	it("rewrites the stored reason to the verdict the re-probe actually returned", async () => {
		const r = rig();
		recordSetAside(r.dir, "agent-1", "m1", SEALED);
		probe.mockResolvedValue(EVICTED);
		await sweepSetAside(r.args);
		expect(loadSetAside(r.dir, "agent-1")[0]?.reason).toBe("mls-evicted");
	});

	// 🔴 A permanent verdict has not earned an attempt count, and claiming one sends
	// an operator looking for a retry loop that never ran.
	it("says the message cannot be read, never that it survived five attempts", async () => {
		const r = rig();
		recordSetAside(r.dir, "agent-1", "m1", SEALED);
		probe.mockResolvedValue(EVICTED);
		await sweepSetAside(r.args);
		const warns = (r.log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
		const line = warns.find((w) => w.includes("m1"));
		expect(line).toContain("cannot be read");
		expect(line).toContain("mls-evicted");
		expect(line).not.toContain("attempts");
		// The tail both arms share: nothing was consumed, so it is still reachable.
		expect(line).toContain("rine_inbox");
	});

	// A permanent verdict on the FIRST sighting was already handled by the store; this
	// pins that the sweep agrees with it rather than re-reading a retired entry.
	it("never re-reads a row the store already recorded as permanently unreadable", async () => {
		const r = rig();
		recordSetAside(r.dir, "agent-1", "m1", REFUSED);
		await sweepSetAside(r.args);
		expect(r.get).not.toHaveBeenCalled();
	});

	// 🔴 One sweep is one bounded batch of reads, not a walk of the whole list: 500
	// entries × (a peeked GET + a decrypt attempt) on a timer tick is the storm the
	// bound exists to prevent. Nothing is skipped — the list is oldest-first, so the
	// tail keeps its place and its attempt count for the next sweep.
	it("retries at most SETASIDE_SWEEP_BATCH entries per sweep, oldest first", async () => {
		const r = rig();
		const total = SETASIDE_SWEEP_BATCH + 3;
		saveSetAside(
			r.dir,
			"agent-1",
			Array.from({ length: total }, (_, i) => ({
				id: `m${i}`,
				reason: "sealed" as const,
				attempts: 0,
				firstSeen: 1000 + i,
				lastTried: null,
				exhausted: false,
			})),
			r.log,
		);
		await sweepSetAside(r.args);
		expect(r.get).toHaveBeenCalledTimes(SETASIDE_SWEEP_BATCH);
		const read = r.get.mock.calls.map((c) => String(c[0]).split("/").pop());
		expect(read[0]).toBe("m0");
		expect(read).not.toContain(`m${total - 1}`);
		// The untouched tail is intact, not dropped: same count, zero attempts spent.
		const after = loadSetAside(r.dir, "agent-1");
		expect(after).toHaveLength(total);
		expect(after[total - 1]).toMatchObject({ id: `m${total - 1}`, attempts: 0 });
		// 🔴 Oldest-first every sweep, `hermes_rine`'s `ORDER BY first_seen ASC
		// LIMIT ?` exactly — NOT least-recently-tried. So a list longer than one
		// batch serves its head again and the tail waits for that head to clear, by
		// healing or by exhausting. Bounded (SETASIDE_MAX_ATTEMPTS sweeps), stated
		// here because it is a shared policy and not an accident of this file.
		await sweepSetAside(r.args);
		const second = r.get.mock.calls.slice(SETASIDE_SWEEP_BATCH).map((c) => String(c[0]));
		expect(second).toHaveLength(SETASIDE_SWEEP_BATCH);
		expect(second[0]).toBe("/messages/m0");
		expect(loadSetAside(r.dir, "agent-1")[0]?.attempts).toBe(2);
		// The tail is reached once the head is gone, not five sweeps of luck later.
		saveSetAside(r.dir, "agent-1", after.slice(SETASIDE_SWEEP_BATCH), r.log);
		await sweepSetAside(r.args);
		expect(r.get.mock.calls.map((c) => String(c[0])).pop()).toBe(`/messages/m${total - 1}`);
	});

	it("dispatches a healed row as a normalized inbound, not as a server row", async () => {
		const r = rig({ get: async () => row("m1", { group_handle: "#team@lab" }) });
		recordSetAside(r.dir, "agent-1", "m1", SEALED);
		probe.mockResolvedValue({ kind: "opened" });
		await sweepSetAside(r.args);
		expect(r.delivered[0]).toMatchObject({
			id: "m1",
			fromHandle: "alice@lab",
			fromAgentId: "agent-alice",
			isGroup: true,
			groupId: "g-1",
			encryptionVersion: "sender-key-v1",
		});
	});
});
