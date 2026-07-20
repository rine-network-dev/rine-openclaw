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
	withAutoPayDefault,
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
	it("removes encrypted_payload and self_encrypted_payload from a flat message result", () => {
		const out = stripCiphertext({
			id: "m1",
			encrypted_payload: "BASE64CIPHER",
			self_encrypted_payload: "SELFCIPHER",
			decrypted: { task: "hi" },
			verified: true,
		}) as Record<string, unknown>;
		expect(out.encrypted_payload).toBeUndefined();
		expect(out.self_encrypted_payload).toBeUndefined();
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
	it("returns exactly the exposed tools when present", () => {
		const all = EXPOSED_TOOLS.map((n) => makeDef(n, async () => ({})));
		const sel = selectExposedTools(all);
		expect(sel.map((t) => t.name)).toEqual([...EXPOSED_TOOLS]);
	});

	it("fails loud when an expected tool name is missing (version skew)", () => {
		const all = makeDef("rine_whoami", async () => ({}));
		expect(() => selectExposedTools([all])).toThrow(/rine_discover|not found/);
	});

	it("exposes rine_thread (REQ-TOOL-01 pull tool, read-only ⇒ not optional)", () => {
		expect([...EXPOSED_TOOLS]).toContain("rine_thread");
		expect(OPTIONAL_TOOLS.has("rine_thread")).toBe(false);
	});

	it("exposes the x402 pay + fulfill tools, both allowlist-gated (fund-moving)", () => {
		expect([...EXPOSED_TOOLS]).toContain("rine_pay");
		expect([...EXPOSED_TOOLS]).toContain("rine_fulfill");
		expect(OPTIONAL_TOOLS.has("rine_pay")).toBe(true);
		expect(OPTIONAL_TOOLS.has("rine_fulfill")).toBe(true);
	});

	it("skips rine_fulfill (lenient) when the installed mcp predates the payee tool", () => {
		// A locally-linked mcp older than the payee minor: every strict tool present, but
		// rine_fulfill absent. It is skipped, not thrown — the plugin still loads.
		const all = EXPOSED_TOOLS.filter((n) => n !== "rine_fulfill").map((n) =>
			makeDef(n, async () => ({})),
		);
		const sel = selectExposedTools(all);
		expect(sel.map((t) => t.name)).toEqual(
			EXPOSED_TOOLS.filter((n) => n !== "rine_fulfill"),
		);
	});

	it("still fails loud when a STRICT tool is missing even if a lenient one is too", () => {
		const all = [makeDef("rine_whoami", async () => ({}))];
		expect(() => selectExposedTools(all)).toThrow(/rine_discover|not found/);
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

	it("rine_thread tool returns the both-sided ThreadEntry rows (REQ-TOOL-01)", async () => {
		// The MCP rine_thread handler returns clean ThreadEntry rows (no ciphertext
		// field), adapted verbatim into the openclaw tool.
		const def = makeDef("rine_thread", async () => ({
			messages: [
				{ direction: "sent", sender_handle: "me@org", text: "my question" },
				{ direction: "received", sender_handle: "alice@org", text: "their answer" },
			],
			truncated: false,
		}));
		const tool = toOpenClawTool(def, fakeCtx) as unknown as {
			execute: (id: string, p: unknown, s?: AbortSignal) => Promise<unknown>;
		};
		const result = (await tool.execute("call1", { conversation_id: "c1" })) as unknown;
		const serialized = JSON.stringify(result);
		expect(serialized).toContain("my question");
		expect(serialized).toContain("their answer");
		expect(serialized).not.toContain("encrypted_payload");
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
	it("passes when both internal tools (rine_reply + rine_send) are present", () => {
		expect(() =>
			assertInternalTools([
				makeDef("rine_reply", async () => ({})),
				makeDef("rine_send", async () => ({})),
			]),
		).not.toThrow();
	});

	it("throws a version-skew error when rine_reply is missing", () => {
		expect(() =>
			assertInternalTools([
				makeDef("rine_whoami", async () => ({})),
				makeDef("rine_send", async () => ({})),
			]),
		).toThrow(/rine_reply|version skew/);
	});

	it("throws a version-skew error when rine_send is missing (backs the outbound adapter)", () => {
		expect(() => assertInternalTools([makeDef("rine_reply", async () => ({}))])).toThrow(
			/rine_send|version skew/,
		);
	});
});

// A full fixture mcp tool set (all exposed + the internal rine_reply dep) so the
// registration tests are deterministic regardless of the linked mcp's version.
function fullToolSet(handler: ToolDef["handler"] = async () => ({})): ToolDef[] {
	return [...EXPOSED_TOOLS, "rine_reply"].map((n) => makeDef(n, handler));
}

describe("registerRineTools", () => {
	it("registers all exposed tools; send/onboard/pay/fulfill carry optional:true", () => {
		const registered: Array<{ name: string; optional?: boolean }> = [];
		const api = {
			registerTool: vi.fn((_tool: unknown, opts?: { name?: string; optional?: boolean }) => {
				registered.push({ name: opts?.name ?? "?", optional: opts?.optional });
			}),
		} as unknown as Parameters<typeof registerRineTools>[0];

		registerRineTools(api, fakeCtx, { tools: fullToolSet() });
		expect(registered.map((r) => r.name).sort()).toEqual([...EXPOSED_TOOLS].sort());
		for (const r of registered) {
			const expectOptional = OPTIONAL_TOOLS.has(r.name);
			expect(Boolean(r.optional)).toBe(expectOptional);
		}
	});

	it("default (autoPay off) leaves rine_pay's auto_pay argument untouched", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const tools = [...EXPOSED_TOOLS, "rine_reply"].map((n) =>
			makeDef(n, async (_ctx, p) => {
				seen.push(p);
				return {};
			}),
		);
		const captured: Array<{ name: string; tool: { execute: (id: string, p: unknown) => Promise<unknown> } }> = [];
		const api = {
			registerTool: vi.fn((tool: { execute: (id: string, p: unknown) => Promise<unknown> }, opts?: { name?: string }) => {
				captured.push({ name: opts?.name ?? "?", tool });
			}),
		} as unknown as Parameters<typeof registerRineTools>[0];

		registerRineTools(api, fakeCtx, { tools });
		const pay = captured.find((c) => c.name === "rine_pay");
		await pay?.tool.execute("call1", {});
		expect(seen.at(-1)).toEqual({}); // auto_pay not injected
	});

	it("opt-in autoPay defaults rine_pay's auto_pay to true (threshold-gated), overridable", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const tools = [...EXPOSED_TOOLS, "rine_reply"].map((n) =>
			makeDef(n, async (_ctx, p) => {
				seen.push(p);
				return {};
			}),
		);
		const captured: Array<{ name: string; tool: { execute: (id: string, p: unknown) => Promise<unknown> } }> = [];
		const api = {
			registerTool: vi.fn((tool: { execute: (id: string, p: unknown) => Promise<unknown> }, opts?: { name?: string }) => {
				captured.push({ name: opts?.name ?? "?", tool });
			}),
		} as unknown as Parameters<typeof registerRineTools>[0];

		registerRineTools(api, fakeCtx, { tools, autoPay: true });
		const pay = captured.find((c) => c.name === "rine_pay");
		await pay?.tool.execute("c", { message_id: "m1" });
		expect(seen.at(-1)).toEqual({ auto_pay: true, message_id: "m1" });
		await pay?.tool.execute("c", { message_id: "m1", auto_pay: false });
		expect(seen.at(-1)).toEqual({ auto_pay: false, message_id: "m1" }); // explicit override wins
	});
});

describe("withAutoPayDefault", () => {
	it("only rewrites rine_pay, and only when autoPay is on", async () => {
		const send = makeDef("rine_send", async () => ({}));
		expect(withAutoPayDefault(send, true)).toBe(send); // non-pay tool untouched
		const pay = makeDef("rine_pay", async () => ({}));
		expect(withAutoPayDefault(pay, false)).toBe(pay); // autoPay off ⇒ identity
		expect(withAutoPayDefault(pay, true)).not.toBe(pay); // autoPay on ⇒ wrapped
	});
});
