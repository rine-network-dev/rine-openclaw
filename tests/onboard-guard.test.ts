import { seedOrgIdentity } from "@rine-network/core/testing";
import type { ToolContext, ToolDef } from "@rine-network/mcp/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardOnboard } from "../src/onboard-guard.js";
import { TEST_AGENT, type TestDirs, freshDirs, seedRuntime } from "./identity.js";

let dirs: TestDirs;
let runtimeCtx: ToolContext;
const onboardCtx = { owner: true } as unknown as ToolContext;
const handler = vi.fn(async (_ctx: ToolContext, _params: Record<string, unknown>) => ({
	status: "registered",
}));
const def: ToolDef = {
	name: "rine_onboard",
	description: "d",
	inputSchema: {},
	handler,
};

beforeEach(() => {
	dirs = freshDirs();
	runtimeCtx = { configDir: dirs.configDir, ownerDir: dirs.ownerDir } as ToolContext;
	handler.mockClear();
});

afterEach(() => dirs.dispose());

describe("guardOnboard", () => {
	it("registers through the owner context when the host holds no identity", async () => {
		const result = await guardOnboard(def, onboardCtx).handler(runtimeCtx, { email: "a@b.c" });

		expect(result).toEqual({ status: "registered" });
		expect(handler).toHaveBeenCalledWith(onboardCtx, { email: "a@b.c" });
	});

	it("answers an installed agent from its own profile and never reaches the owner context", async () => {
		seedRuntime(dirs);
		seedOrgIdentity(dirs.ownerDir);

		const result = await guardOnboard(def, onboardCtx).handler(runtimeCtx, {});

		expect(result).toMatchObject({ status: "already_registered", agent_id: TEST_AGENT });
		expect(handler).not.toHaveBeenCalled();
	});

	it("refuses a host whose owner dir holds an org root and no agent", async () => {
		seedOrgIdentity(dirs.ownerDir);

		await expect(guardOnboard(def, onboardCtx).handler(runtimeCtx, {})).rejects.toThrow(
			/rine agent create/,
		);
		expect(handler).not.toHaveBeenCalled();
	});
});
