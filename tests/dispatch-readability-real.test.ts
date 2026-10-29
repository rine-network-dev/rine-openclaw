import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAgentKeys } from "@rine-network/core";
import { makeOnMessage } from "../src/dispatch.js";
import type { RineClient } from "../src/rine-client.js";
import { loadSetAside } from "../src/setaside.js";
import type { RineConfig, RineInbound } from "../src/types.js";
import { derivedAgentKeys, logger, rineConfig } from "./helpers.js";

/**
 * The readability gate with the REAL `probeReadability` — no `vi.mock`, which is
 * why this is its own file: the mock in `dispatch-readability.test.ts` is
 * module-level and every test there shares it.
 *
 * 🔴 What it exists to catch is the class of defect a mocked probe cannot: the
 * gate agreeing with its own stub. `isDispatchable` narrows off `rine-core`'s
 * verdict vocabulary, `readabilityArgsFor` maps this package's `RineInbound` onto
 * core's `OpenInboundArgs` field by field, and a rename or a dropped field on
 * either side would show up here as a message that quietly stops opening — while
 * every mocked test kept passing.
 *
 * It deliberately asserts the OUTCOME (not dispatched, not acked, parked) rather
 * than which unreadable arm core picked. Core's own suite owns the ladder; this
 * one owns "openclaw does the right thing with whatever it is told", and pinning
 * the arm here would make a legitimate reclassification in core fail in a package
 * that has no opinion about it.
 */

const created: string[] = [];
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "rine-gate-real-"));
	created.push(dir);
	return dir;
}

const CONFIG: RineConfig = rineConfig({
	pollIntervalMs: 1000,
	reconnectBaseMs: 100,
	reconnectMaxMs: 1000,
});

/**
 * This agent's id, a real UUID.
 *
 * 🔴 Not a readable stub like `agent-1`: `saveAgentKeys` runs core's
 * `validatePathId` over it (the agent id becomes a directory name under the
 * config dir) and throws on anything that is not UUID-shaped. The mocked tests
 * next door never touch key storage, so only this file has to say a real one.
 */
const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** A group post under a sender key this agent has never been given. */
function sealedGroupPost(): RineInbound {
	return {
		id: "m-sealed",
		conversationId: "conv-1",
		fromHandle: "alice@lab",
		type: "rine.v1.group_post",
		isGroup: true,
		groupId: "11111111-2222-3333-4444-555555555555",
		// Well-formed base64 of a JSON envelope shape, so the refusal comes from the
		// missing key rather than from a parse this test did not mean to exercise.
		encryptedPayload: Buffer.from(
			JSON.stringify({ v: "sender-key-v1", kid: "sk-nobody-has", ct: "AAAA" }),
		).toString("base64"),
		encryptionVersion: "sender-key-v1",
		fromAgentId: "66666666-7777-8888-9999-000000000000",
	};
}

const running: AbortController[] = [];

afterEach(() => {
	for (const c of running.splice(0)) c.abort();
	for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readability gate — against the real core ladder", () => {
	it("parks a real unreadable group row without dispatching or acking it", async () => {
		const dir = tmp();
		// Real key material, so the ladder goes PAST core's `no-keys` pre-gate and
		// the verdict is about the message rather than about the config dir.
		saveAgentKeys(dir, AGENT_ID, derivedAgentKeys(AGENT_ID));
		const log = logger();
		const markDelivered = vi.fn(async () => 1);
		const dispatch = vi.fn(async () => {});
		const controller = new AbortController();
		running.push(controller);
		const onMessage = makeOnMessage({
			client: {
				markDelivered,
				configDir: dir,
				client: {
					get: vi.fn(async () => {
						throw Object.assign(new Error("not found"), { status: 404 });
					}),
				},
			} as unknown as RineClient,
			config: CONFIG,
			agentId: AGENT_ID,
			logger: log,
			dispatch,
			signal: controller.signal,
		});

		expect(await onMessage(sealedGroupPost())).toBe(true);
		expect(dispatch).not.toHaveBeenCalled();
		expect(markDelivered).not.toHaveBeenCalled();
		const parked = loadSetAside(dir, AGENT_ID);
		expect(parked).toHaveLength(1);
		expect(parked[0]?.id).toBe("m-sealed");
		// Not `no-keys`: that arm would mean the fixture never reached the decrypt,
		// and the test would be asserting nothing about a group message.
		expect(parked[0]?.reason).not.toBe("no-keys");
		expect(parked[0]?.reason).not.toBe("not-ciphertext");
	});
});
