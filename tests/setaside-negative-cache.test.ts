import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { probe, byId, recover, cached } = vi.hoisted(() => ({
	probe: vi.fn(),
	byId: vi.fn(),
	recover: vi.fn(),
	cached: vi.fn(),
}));

// The cache itself is core's to test; what is under test is whether the sweep
// asks it, with which key, and what it does with the answer.
vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...actual,
		probeReadability: probe,
		readableGroupById: byId,
		recoverGroup: recover,
		isCached: cached,
	};
});

import type { GroupRead, HttpClient, MessageRead } from "@rine-network/core";
import { dropSetAside, loadSetAside, recordSetAside } from "../src/setaside.js";
import { sweepSetAside } from "../src/setaside-sweep.js";
import { logger } from "./helpers.js";

const GROUP = "11111111-2222-3333-4444-555555555555";
const SEALED = { kind: "sealed", groupId: GROUP, senderKeyId: "sk-1" } as const;

const created: string[] = [];

function rig(id: string) {
	const dir = mkdtempSync(join(tmpdir(), "rine-setaside-cache-"));
	created.push(dir);
	const get = vi.fn(
		async () =>
			({
				id,
				conversation_id: "conv",
				sender_handle: "alice@lab",
				from_agent_id: "agent-alice",
				type: "rine.v1.group_post",
				encrypted_payload: "CIPHER",
				encryption_version: "sender-key-v1",
				created_at: "2026-09-14T00:00:00Z",
				group_id: GROUP,
			}) as MessageRead,
	);
	const deliver = vi.fn(async () => true);
	const args = {
		client: { get } as unknown as HttpClient,
		configDir: dir,
		agentId: "agent-1",
		logger: logger(),
		deliver,
	};
	recordSetAside(dir, "agent-1", id, SEALED);
	return { dir, args, deliver };
}

beforeEach(() => {
	probe.mockReset().mockResolvedValue(SEALED);
	byId.mockReset().mockResolvedValue({ id: GROUP, handle: "#t@lab", name: "t" } as unknown as GroupRead);
	recover.mockReset().mockResolvedValue({ regime: "sender-key", ingested: 0, retired: false });
	cached.mockReset().mockReturnValue(false);
});

afterEach(() => {
	for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("set-aside sweep and the sender-key negative cache", () => {
	// 🔴 Mutation check: delete the `isWaitingOnCachedKey` call from `retryOne`
	// and the second sweep syncs, probes and counts an attempt, so this goes red.
	it("skips a sealed row whose key is a live cache entry: no sync, no probe, no attempt", async () => {
		const r = rig("m-skip");
		await sweepSetAside(r.args);
		expect(recover).toHaveBeenCalledTimes(1);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(loadSetAside(r.dir, "agent-1")[0]?.attempts).toBe(1);

		cached.mockReturnValue(true);
		await sweepSetAside(r.args);
		await sweepSetAside(r.args);

		expect(recover).toHaveBeenCalledTimes(1);
		expect(probe).toHaveBeenCalledTimes(1);
		const [row] = loadSetAside(r.dir, "agent-1");
		expect(row?.attempts).toBe(1);
		expect(row?.reason).toBe("sealed");
		expect(row?.exhausted).toBe(false);
		expect(r.deliver).not.toHaveBeenCalled();
	});

	it("asks the cache for this agent, the row's group, its sender and the key the verdict named", async () => {
		const r = rig("m-key");
		await sweepSetAside(r.args);
		await sweepSetAside(r.args);
		expect(cached).toHaveBeenCalledWith("agent-1", GROUP, "agent-alice", "sk-1");
	});

	it("retries the row once the entry clears", async () => {
		const r = rig("m-clear");
		await sweepSetAside(r.args);
		cached.mockReturnValue(true);
		await sweepSetAside(r.args);
		expect(recover).toHaveBeenCalledTimes(1);

		cached.mockReturnValue(false);
		probe.mockResolvedValue({ kind: "opened" });
		await sweepSetAside(r.args);
		expect(recover).toHaveBeenCalledTimes(2);
		expect(r.deliver).toHaveBeenCalledTimes(1);
		expect(loadSetAside(r.dir, "agent-1")).toEqual([]);
	});

	// 🔴 Mutation check: delete the `pruneSealedKeyIds` call from `sweepSetAside`
	// and the key id learnt for m-gone outlives its row, so m-gone is skipped
	// unprobed on its return and this goes red.
	it("forgets the key id of a row that left the store, so the id is probed afresh if it returns", async () => {
		const r = rig("m-gone");
		await sweepSetAside(r.args);
		expect(probe).toHaveBeenCalledTimes(1);

		dropSetAside(r.dir, "agent-1", "m-gone", r.args.logger);
		recordSetAside(r.dir, "agent-1", "m-other", SEALED);
		await sweepSetAside(r.args);
		const probed = probe.mock.calls.length;

		recordSetAside(r.dir, "agent-1", "m-gone", SEALED);
		cached.mockReturnValue(true);
		await sweepSetAside(r.args);
		expect(probe.mock.calls.length).toBeGreaterThan(probed);
	});

	it("does not ask the cache for a row that is not sealed", async () => {
		const r = rig("m-mls");
		probe.mockResolvedValue({ kind: "mls-recoverable", groupId: GROUP, err: new Error("x") });
		recordSetAside(r.dir, "agent-1", "m-mls", { kind: "mls-recoverable", groupId: GROUP, err: new Error("x") });
		await sweepSetAside(r.args);
		await sweepSetAside(r.args);
		expect(cached).not.toHaveBeenCalled();
	});
});
