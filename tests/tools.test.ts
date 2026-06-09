import { describe, expect, it, vi } from "vitest";
import type { ToolContext, ToolDef } from "@rine-network/mcp/tools";
import {
	assertInternalTools,
	EXPOSED_TOOLS,
	OPTIONAL_TOOLS,
	registerRineTools,
	selectExposedTools,
	stripCiphertext,
	toOpenClawTool,
} from "../src/tools.js";

const fakeCtx = {} as ToolContext;

function makeDef(name: string, handler: ToolDef["handler"]): ToolDef {
	return {
		name,
		description: `desc ${name}`,
		inputSchema: { type: "object", properties: {} },
		handler,
	};
}

describe("stripCiphertext", () => {
	it("removes encrypted_payload from a flat message result", () => {
		const out = stripCiphertext({
			id: "m1",
			encrypted_payload: "BASE64CIPHER",
			decrypted: { task: "hi" },
			verified: true,
		}) as Record<string, unknown>;
		expect(out.encrypted_payload).toBeUndefined();
		expect(out.decrypted).toEqual({ task: "hi" });
		expect(out.verified).toBe(true);
	});

	it("strips ciphertext from arrays/items (rine_inbox shape)", () => {
		const out = stripCiphertext({
			items: [
				{ id: "a", encrypted_payload: "X", decrypted: 1 },
				{ id: "b", encrypted_payload: "Y", decrypted: 2 },
			],
			next_cursor: "c",
		}) as { items: Array<Record<string, unknown>> };
		expect(out.items.every((i) => i.encrypted_payload === undefined)).toBe(true);
		expect(out.items.map((i) => i.decrypted)).toEqual([1, 2]);
	});

	it("passes primitives through unchanged", () => {
		expect(stripCiphertext("plain")).toBe("plain");
		expect(stripCiphertext(42)).toBe(42);
	});
});

describe("selectExposedTools", () => {
	it("returns exactly the 6 exposed tools when present", () => {
		const all = EXPOSED_TOOLS.map((n) => makeDef(n, async () => ({})));
		const sel = selectExposedTools(all);
		expect(sel.map((t) => t.name)).toEqual([...EXPOSED_TOOLS]);
	});

	it("fails loud when an expected tool name is missing (version skew)", () => {
		const all = makeDef("rine_whoami", async () => ({}));
		expect(() => selectExposedTools([all])).toThrow(/rine_discover|not found/);
	});
});

describe("toOpenClawTool", () => {
	it("execute returns a jsonResult with ciphertext stripped", async () => {
		const def = makeDef("rine_read", async () => ({
			id: "m1",
			encrypted_payload: "CIPHER",
			decrypted: { ok: 1 },
			verified: true,
		}));
		const tool = toOpenClawTool(def, fakeCtx) as unknown as {
			execute: (id: string, p: unknown, s?: AbortSignal) => Promise<unknown>;
		};
		const result = (await tool.execute("call1", {})) as { content?: unknown };
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("CIPHER");
		expect(serialized).not.toContain("encrypted_payload");
		expect(serialized).toContain("decrypted");
	});

	it("execute honors an aborted signal", async () => {
		const def = makeDef("rine_read", async () => ({}));
		const tool = toOpenClawTool(def, fakeCtx) as unknown as {
			execute: (id: string, p: unknown, s?: AbortSignal) => Promise<unknown>;
		};
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(tool.execute("c", {}, ctrl.signal)).rejects.toThrow();
	});

	it("converts a thrown handler error into an error result, not a throw (SU-5)", async () => {
		const def = makeDef("rine_send", async () => {
			throw new Error("approval required");
		});
		const tool = toOpenClawTool(def, fakeCtx) as unknown as {
			execute: (id: string, p: unknown, s?: AbortSignal) => Promise<unknown>;
		};
		const result = await tool.execute("call1", { to: "x@y", payload: {} });
		const serialized = JSON.stringify(result);
		expect(serialized).toContain("rine_send failed");
		expect(serialized).toContain("approval required");
	});
});

describe("assertInternalTools (QP-8)", () => {
	it("passes when rine_reply is present", () => {
		expect(() => assertInternalTools([makeDef("rine_reply", async () => ({}))])).not.toThrow();
	});

	it("throws a version-skew error when rine_reply is missing", () => {
		expect(() => assertInternalTools([makeDef("rine_whoami", async () => ({}))])).toThrow(
			/rine_reply|version skew/,
		);
	});
});

describe("registerRineTools", () => {
	it("registers all 6 tools; send/onboard carry optional:true", () => {
		const registered: Array<{ name: string; optional?: boolean }> = [];
		const api = {
			registerTool: vi.fn((_tool: unknown, opts?: { name?: string; optional?: boolean }) => {
				registered.push({ name: opts?.name ?? "?", optional: opts?.optional });
			}),
		} as unknown as Parameters<typeof registerRineTools>[0];

		registerRineTools(api, fakeCtx);
		expect(registered.map((r) => r.name).sort()).toEqual([...EXPOSED_TOOLS].sort());
		for (const r of registered) {
			const expectOptional = OPTIONAL_TOOLS.has(r.name);
			expect(Boolean(r.optional)).toBe(expectOptional);
		}
	});
});
