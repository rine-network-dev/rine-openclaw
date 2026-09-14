import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted above the imports — the spies must exist first.
const { probe, byId, recover } = vi.hoisted(() => ({
	probe: vi.fn(),
	byId: vi.fn(),
	recover: vi.fn(),
}));

// Three exports replaced and the rest kept REAL, the `setaside.test.ts` rule:
// `UUID_RE` and `ACTING_AGENT_HEADER` are asserted here, so a local copy would
// make this file agree with itself and with nothing else. `recoverGroup` and
// `readableGroupById` are `rine-core`'s own to test — what is under test is
// whether the retry path asks them, with what, and how often.
vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...actual,
		probeReadability: probe,
		readableGroupById: byId,
		recoverGroup: recover,
	};
});

import { ACTING_AGENT_HEADER } from "@rine-network/core";
import type { GroupRead, HttpClient, MessageRead } from "@rine-network/core";
import {
	groupSyncMayHeal,
	loadSetAside,
	recordSetAside,
	saveSetAside,
} from "../src/setaside.js";
import type { SetAsideEntry, SetAsideReason } from "../src/setaside.js";
import { sweepSetAside } from "../src/setaside-sweep.js";
import type { RineInbound } from "../src/types.js";
import { logger } from "./helpers.js";

/**
 * The sweep syncs the group before it retries the decrypt.
 *
 * 🔴 What the mutation test at the top of the sweep block is for: before this,
 * five attempts over twenty-five minutes re-read the same row and tried the same
 * local key material against the same bytes, so a sealed group message could
 * only heal if something ELSE happened to install the key. Delete the sync call
 * from `retryOne` and that test goes red, because its `probe` opens on nothing
 * else — which is the only way a test of this can be worth having.
 *
 * The group id is a real UUID in every fixture here, deliberately: the other
 * suites' rows carry `group_id: "g-1"`, which `UUID_RE` refuses, so they exercise
 * the gate's refusal and this file exercises everything behind it.
 */

const GROUP = "11111111-2222-3333-4444-555555555555";
const OTHER_GROUP = "99999999-8888-7777-6666-555555555555";

const created: string[] = [];
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "rine-setaside-sync-"));
	created.push(dir);
	return dir;
}

const SEALED: SetAsideReason = {
	kind: "sealed",
	groupId: GROUP,
	senderKeyId: "sk-1",
};

function row(id: string, over: Partial<MessageRead> = {}): MessageRead {
	return {
		id,
		conversation_id: `conv-${id}`,
		sender_handle: "alice@lab",
		from_agent_id: "agent-alice",
		type: "rine.v1.group_post",
		encrypted_payload: "CIPHER",
		encryption_version: "sender-key-v1",
		created_at: "2026-09-14T00:00:00Z",
		group_id: GROUP,
		...over,
	};
}

function group(id = GROUP): GroupRead {
	return { id, handle: `#team@lab`, name: "team" } as unknown as GroupRead;
}

type Get = (
	path: string,
	params?: Record<string, unknown>,
	headers?: Record<string, string>,
) => Promise<unknown>;

/** A sweep rig, the `setaside.test.ts` shape, with a scripted group read. */
function rig(opts: { get?: Get } = {}) {
	const dir = tmp();
	const log = logger();
	const get = vi.fn<Get>(
		opts.get ?? (async (p: string) => row(p.split("/").pop() as string)),
	);
	const delivered: RineInbound[] = [];
	const deliver = vi.fn(async (msg: RineInbound) => {
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
	return { dir, log, get, deliver, delivered, args };
}

/** Park `n` entries on one group, as the store really records them. */
function park(dir: string, ids: string[], reason: SetAsideReason = SEALED): void {
	for (const id of ids) recordSetAside(dir, "agent-1", id, reason);
}

beforeEach(() => {
	probe.mockReset();
	byId.mockReset();
	recover.mockReset();
	probe.mockResolvedValue({ kind: "sealed", groupId: GROUP, senderKeyId: "sk-1" });
	byId.mockResolvedValue(group());
	recover.mockResolvedValue({ regime: "sender-key", ingested: 1, retired: false });
});

afterEach(() => {
	for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("groupSyncMayHeal", () => {
	// 🔴 The table is the policy. `mls-evicted` is the arm that proves the question
	// is asked rather than assumed: no sync undoes a Remove.
	it("says yes to exactly the two arms a sync can heal", () => {
		expect(groupSyncMayHeal("sealed")).toBe(true);
		expect(groupSyncMayHeal("mls-recoverable")).toBe(true);
	});

	it("says no to mls-evicted, refused, failed and no-keys", () => {
		for (const reason of ["mls-evicted", "refused", "failed", "no-keys"] as const) {
			expect(groupSyncMayHeal(reason)).toBe(false);
		}
	});

	// A `reason` a newer build wrote and this one has no arm for: the lookup
	// misses, and a miss must not read as "sync it".
	it("says no to a reason it does not know", () => {
		expect(groupSyncMayHeal("some-future-arm" as SetAsideEntry["reason"])).toBe(false);
	});
});

describe("set-aside retry sweep — syncs before it retries", () => {
	// 🔴 THE test. The probe opens only once `recoverGroup` has run, which is what
	// a sync really does: it installs the sender key the message was sealed under.
	// Remove the sync from `retryOne` and this goes red — there is no other path
	// here that could open the message.
	it("delivers a sealed message that only the sync can open", async () => {
		const r = rig();
		park(r.dir, ["m1"]);
		probe.mockImplementation(async () =>
			recover.mock.calls.length > 0
				? { kind: "opened" }
				: { kind: "sealed", groupId: GROUP, senderKeyId: "sk-1" },
		);
		await sweepSetAside(r.args);
		expect(recover).toHaveBeenCalledTimes(1);
		expect(r.delivered.map((m) => m.id)).toEqual(["m1"]);
		expect(loadSetAside(r.dir, "agent-1")).toEqual([]);
	});

	// 🔴 Order, not merely presence: a sync after a failed decrypt heals nothing
	// until the NEXT sweep, five minutes later.
	it("syncs BEFORE the decrypt is retried", async () => {
		const r = rig();
		park(r.dir, ["m1"]);
		await sweepSetAside(r.args);
		expect(recover.mock.invocationCallOrder[0] as number).toBeLessThan(
			probe.mock.invocationCallOrder[0] as number,
		);
	});

	// The row is resolved through core's own reader and the ROW is what recovery
	// gets — never the bare id the server handed us.
	it("resolves the group by id and hands recoverGroup the resolved row", async () => {
		const r = rig();
		park(r.dir, ["m1"]);
		await sweepSetAside(r.args);
		expect(byId).toHaveBeenCalledWith(r.args.client, GROUP, {
			[ACTING_AGENT_HEADER]: "agent-1",
		});
		expect(recover).toHaveBeenCalledWith(
			r.dir,
			"agent-1",
			group(),
			r.args.client,
			{ [ACTING_AGENT_HEADER]: "agent-1" },
		);
	});

	// 🔴 Once per group per SWEEP. One absent sender key seals every message sent
	// under it, so many entries on one group is the ordinary shape of this list,
	// and a sync per entry would ask the same question once per message.
	it("syncs once for a whole batch parked on the same group", async () => {
		const r = rig();
		park(r.dir, ["m1", "m2", "m3", "m4"]);
		await sweepSetAside(r.args);
		expect(probe).toHaveBeenCalledTimes(4);
		expect(recover).toHaveBeenCalledTimes(1);
	});

	it("syncs each group once when a batch spans two", async () => {
		const r = rig({
			get: async (p: string) => {
				const id = p.split("/").pop() as string;
				return row(id, { group_id: id === "m2" ? OTHER_GROUP : GROUP });
			},
		});
		park(r.dir, ["m1", "m2", "m3"]);
		await sweepSetAside(r.args);
		expect(recover).toHaveBeenCalledTimes(2);
		// Sorted, not in call order: which of the two goes first is the store's
		// oldest-first ordering and is another test's business.
		expect(byId.mock.calls.map((c) => String(c[1])).sort()).toEqual(
			[GROUP, OTHER_GROUP].sort(),
		);
	});

	// The other arm the table admits, exercised through the sweep and not only as
	// a predicate: an MLS message no local key opens yet is what the replay rung
	// of a sync exists for.
	it("syncs for an `mls-recoverable` entry too", async () => {
		const r = rig();
		park(r.dir, ["m1"], {
			kind: "mls-recoverable",
			groupId: GROUP,
			err: new Error("no key for this epoch"),
		});
		recover.mockResolvedValue({
			regime: "mls",
			rung: "replay",
			fromEpoch: 3,
			epoch: 7,
			behind: 4,
			processed: 4,
			evicted: false,
		});
		await sweepSetAside(r.args);
		expect(recover).toHaveBeenCalledTimes(1);
		expect(r.log.debug).toHaveBeenCalledWith(expect.stringContaining("(mls)"));
	});

	// A new sweep is a new question: five minutes on, the key may have arrived.
	it("syncs again on the next sweep", async () => {
		const r = rig();
		park(r.dir, ["m1"]);
		await sweepSetAside(r.args);
		await sweepSetAside(r.args);
		expect(recover).toHaveBeenCalledTimes(2);
	});
});

describe("set-aside retry sweep — what it declines to sync", () => {
	// The verdicts a sync cannot heal spend no round trip on one. `failed` is the
	// unknown-cause arm and is the one of these that the sweep really does reach:
	// `mls-evicted` and `refused` are recorded already-exhausted, so they are
	// filtered out before this.
	it("does not sync for a `failed` entry, but still retries it", async () => {
		const r = rig();
		park(r.dir, ["m1"], { kind: "failed", groupId: GROUP, err: new Error("x") });
		await sweepSetAside(r.args);
		expect(byId).not.toHaveBeenCalled();
		expect(recover).not.toHaveBeenCalled();
		expect(probe).toHaveBeenCalledTimes(1);
		expect(loadSetAside(r.dir, "agent-1")[0]?.attempts).toBe(1);
	});

	it("does not sync for a DM, which has no group to catch up", async () => {
		// `null` and not absent, because `null` is what the server really answers for
		// a DM. `MessageRead.group_id` is typed `string | undefined`, which the wire
		// is not — the cast is that type's inaccuracy, not this fixture's licence.
		const r = rig({
			get: async (p) =>
				row(p.split("/").pop() as string, { group_id: null as unknown as undefined }),
		});
		park(r.dir, ["m1"]);
		await sweepSetAside(r.args);
		expect(byId).not.toHaveBeenCalled();
		expect(probe).toHaveBeenCalledTimes(1);
	});

	// 🔴 The untrusted-id gate. The id arrives in a server row, and the request
	// path is built from it — so a `group_id` that is not a UUID never reaches a
	// URL. It costs nothing real: the producer is the server's own UUID
	// serialiser, which emits the canonical dashed form and nothing else.
	it("never asks about a group id that is not a UUID", async () => {
		const r = rig({
			get: async (p) =>
				row(p.split("/").pop() as string, { group_id: "../agents/agent-victim" }),
		});
		park(r.dir, ["m1"]);
		await sweepSetAside(r.args);
		expect(byId).not.toHaveBeenCalled();
		expect(recover).not.toHaveBeenCalled();
		// Still retried — the sync is an extra rung, never a precondition.
		expect(probe).toHaveBeenCalledTimes(1);
		expect(loadSetAside(r.dir, "agent-1")[0]?.attempts).toBe(1);
	});

	it("does not recover a group the server will no longer serve this agent", async () => {
		const r = rig();
		park(r.dir, ["m1"]);
		byId.mockResolvedValue(undefined);
		await sweepSetAside(r.args);
		expect(recover).not.toHaveBeenCalled();
		expect(probe).toHaveBeenCalledTimes(1);
		expect(r.log.debug).toHaveBeenCalledWith(expect.stringContaining("not readable"));
	});
});

describe("set-aside retry sweep — a failing sync costs the message nothing", () => {
	// 🔴 The attempt bound counts retries of the DECRYPT. A sync failure that
	// consumed one would let a server that is down for twenty-five minutes exhaust
	// a message's five chances without a single decrypt ever having been tried.
	it("still retries the decrypt, and spends exactly one attempt", async () => {
		const r = rig();
		park(r.dir, ["m1"]);
		recover.mockRejectedValue(new Error("group state will not load"));
		await expect(sweepSetAside(r.args)).resolves.toBeUndefined();
		expect(probe).toHaveBeenCalledTimes(1);
		expect(loadSetAside(r.dir, "agent-1")[0]?.attempts).toBe(1);
		expect(r.log.warn).toHaveBeenCalledWith(
			expect.stringContaining("could not sync group"),
		);
	});

	it("survives a group read that throws, and says so once", async () => {
		const r = rig();
		park(r.dir, ["m1", "m2"]);
		byId.mockRejectedValue(new Error("gateway"));
		await expect(sweepSetAside(r.args)).resolves.toBeUndefined();
		expect(probe).toHaveBeenCalledTimes(2);
		const warns = (r.log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
		expect(warns.filter((w) => w.includes("could not sync group"))).toHaveLength(1);
	});

	// A group whose sync keeps failing must not be asked once per parked entry:
	// the id joins the per-sweep set BEFORE the await, so a rejection cannot
	// re-open the question for the rest of the batch.
	it("does not re-ask a failing group for every entry in the batch", async () => {
		const r = rig();
		const ids = Array.from({ length: 6 }, (_, i) => `m${i}`);
		park(r.dir, ids);
		recover.mockRejectedValue(new Error("boom"));
		await sweepSetAside(r.args);
		expect(recover).toHaveBeenCalledTimes(1);
		expect(probe).toHaveBeenCalledTimes(6);
	});

	// An exhausted entry is not swept at all, so a group only it is parked on
	// costs no sync either.
	it("syncs nothing when every entry has been given up on", async () => {
		const r = rig();
		saveSetAside(
			r.dir,
			"agent-1",
			[
				{
					id: "m1",
					reason: "sealed",
					attempts: 5,
					firstSeen: 1000,
					lastTried: 2000,
					exhausted: true,
				},
			],
			r.log,
		);
		await sweepSetAside(r.args);
		expect(byId).not.toHaveBeenCalled();
		expect(r.get).not.toHaveBeenCalled();
	});
});
