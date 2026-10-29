import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAgentKeys } from "@rine-network/core";
import type { HttpClient } from "@rine-network/core";
import { syncGroupForRetry } from "../src/setaside-sync.js";
import { derivedAgentKeys, logger } from "./helpers.js";

/**
 * The background retry reaches core's seat retake, with nothing in core mocked.
 *
 * `setaside-sync.test.ts` replaces `recoverGroup` and so proves only that the retry
 * ASKS for a recovery. This one lets the real `recoverGroup` run against a scripted
 * server for a closed group this agent holds no local state for, and reads what
 * the retry sent: the scoped Welcome fetch first, then the group's published
 * GroupInfo, which is the request only the seat retake makes. The server publishes
 * no GroupInfo here, so the retake answers "no seat to take back" and the retry
 * logs that and does not throw.
 */

const GROUP = "11111111-2222-3333-4444-555555555555";
const AGENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scriptedServer() {
	const asked: string[] = [];
	const get = vi.fn(async (path: string) => {
		asked.push(path);
		if (path === `/groups/${GROUP}`) {
			return { id: GROUP, handle: "#team@lab", name: "team", mls_group_id: "opaque" };
		}
		if (path === `/agents/${AGENT}/mls/welcomes`) return { welcomes: [] };
		if (path === `/groups/${GROUP}/mls/group-info`) return { group_info: null, epoch: null };
		return {};
	});
	const post = vi.fn(async () => ({}));
	return { asked, client: { get, post } as unknown as HttpClient };
}

describe("the set-aside retry of a seated agent that holds no group state", () => {
	it("fetches its Welcomes, then asks for the GroupInfo the seat retake commits against", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rine-setaside-retake-"));
		dirs.push(dir);
		saveAgentKeys(dir, AGENT, derivedAgentKeys(AGENT));
		const { asked, client } = scriptedServer();
		const log = logger();

		await syncGroupForRetry({ client, configDir: dir, agentId: AGENT, logger: log }, GROUP, new Set());

		const welcomes = asked.indexOf(`/agents/${AGENT}/mls/welcomes`);
		const groupInfo = asked.indexOf(`/groups/${GROUP}/mls/group-info`);
		expect(welcomes).toBeGreaterThanOrEqual(0);
		expect(groupInfo).toBeGreaterThan(welcomes);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(log.warn).mock.calls[0]?.[0]).toContain("local group state will not load");
	});
});
