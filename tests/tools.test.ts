import { GROUP_READERS_NOTICE } from "@rine-network/core";
import { describe, expect, it, vi } from "vitest";
import { tools as mcpTools } from "@rine-network/mcp/tools";
import type { ToolContext, ToolDef } from "@rine-network/mcp/tools";
import { ACTOR_TOOLS, withActingAgent } from "../src/tool-actor.js";
import { freshDirs } from "./identity.js";
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

	it("exposes rine_onboard ungated (a fresh install must be able to register itself)", () => {
		expect([...EXPOSED_TOOLS]).toContain("rine_onboard");
		expect(OPTIONAL_TOOLS.has("rine_onboard")).toBe(false);
	});

	it("exposes rine_thread (pull tool, read-only ⇒ not optional)", () => {
		expect([...EXPOSED_TOOLS]).toContain("rine_thread");
		expect(OPTIONAL_TOOLS.has("rine_thread")).toBe(false);
	});

	it("exposes rine_inspect ungated — it is the same unauthenticated read as rine_discover", () => {
		expect([...EXPOSED_TOOLS]).toContain("rine_inspect");
		expect(OPTIONAL_TOOLS.has("rine_inspect")).toBe(false);
	});

	it("gates rine_send_and_wait — waiting for the reply does not un-send the message", () => {
		expect([...EXPOSED_TOOLS]).toContain("rine_send_and_wait");
		expect(OPTIONAL_TOOLS.has("rine_send_and_wait")).toBe(true);
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

	it("fails loud when a group verb is missing — they are strict, not lenient", () => {
		// An mcp old enough to lack the group verbs must fail the load rather than
		// quietly offering a plugin with no group surface. Every published openclaw
		// pins an mcp `^`-range that carries them, so this can only bite a local link.
		const all = EXPOSED_TOOLS.filter((n) => n !== "rine_group_sync").map((n) =>
			makeDef(n, async () => ({})),
		);
		expect(() => selectExposedTools(all)).toThrow(/rine_group_sync/);
	});
});

describe("the group surface (allowlist gating)", () => {
	const GROUP_TOOLS = [
		"rine_discover_groups",
		"rine_groups",
		"rine_group_create",
		"rine_group_join",
		"rine_group_roster",
		"rine_group_inspect",
		"rine_group_invite",
		"rine_group_invites",
		"rine_group_requests",
		"rine_group_vote",
		"rine_group_leave",
		"rine_group_remove",
		"rine_group_sync",
		"rine_group_reclaim",
	];

	it("exposes the whole group domain, so an agent can join and run a group", () => {
		for (const name of GROUP_TOOLS) expect([...EXPOSED_TOOLS]).toContain(name);
	});

	it("gates the four group verbs that act on a third party, and only those", () => {
		// An invite acts on the group's roster on membership alone: on a closed group it
		// hands a stranger a seat plus their leaf and Welcome in the same call, and on a
		// majority or unanimity group it files a join request in the group's name and
		// spends this host's own approval on it. An approve hands a stranger the group's
		// keys; a remove evicts somebody else; reclamation posts a Remove commit per
		// orphaned leaf and can take a freshly re-invited agent's with them.
		const want = [
			"rine_group_invite",
			"rine_group_vote",
			"rine_group_remove",
			"rine_group_reclaim",
		];
		for (const name of want) expect(OPTIONAL_TOOLS.has(name)).toBe(true);
		const gated = GROUP_TOOLS.filter((n) => OPTIONAL_TOOLS.has(n));
		expect(gated).toEqual(want);
	});

	it("tells the agent, in the tool text it reads, that every member org can read the group", () => {
		const registered: Array<{ name: string; description: string }> = [];
		const api = { registerTool: (t: { name: string; description: string }) => registered.push(t) };
		registerRineTools(api as never, fakeCtx, { onboardContext: fakeCtx, autoPay: false });
		for (const name of ["rine_group_create", "rine_group_join"]) {
			expect(registered.find((t) => t.name === name)?.description).toContain(GROUP_READERS_NOTICE);
		}
	});

	it("leaves rine_group_leave ungated — it acts only on this host", () => {
		// Irreversible, but gating it would leave an agent unable to get out of a
		// group somebody else put it in.
		expect(OPTIONAL_TOOLS.has("rine_group_leave")).toBe(false);
	});

	it("leaves the whole default-install path ungated (create/discover/join/read)", () => {
		// Inviting is NOT on this path: an agent can create, find, join and read a group
		// without the operator touching the allowlist, but seating somebody else needs one.
		for (const name of [
			"rine_discover_groups",
			"rine_groups",
			"rine_group_create",
			"rine_group_join",
			"rine_group_roster",
			"rine_group_inspect",
			"rine_group_invites",
			"rine_group_requests",
			"rine_group_sync",
		]) {
			expect(OPTIONAL_TOOLS.has(name)).toBe(false);
		}
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

	it("rine_thread tool returns the both-sided ThreadEntry rows", async () => {
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

	// Inheritance. This plugin re-exports the MCP array BY NAME, so a
	// capability's only trace here is a string in `EXPOSED_TOOLS` — the group
	// reference reaches an openclaw host only if the REAL def's schema and
	// refusal survive `selectExposedTools` → `withActingAgent` → `toOpenClawTool`.
	// A fake def would prove none of that, so this one comes from the array.
	it("inherits rine_thread's group reference from the MCP def, refusal included", async () => {
		const def = selectExposedTools(mcpTools).find((t) => t.name === "rine_thread");
		if (!def) throw new Error("rine_thread is not exposed");
		const tool = toOpenClawTool(
			withActingAgent(def, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
			fakeCtx,
		) as unknown as {
			parameters: { properties: Record<string, unknown> };
			execute: (id: string, p: unknown, s?: AbortSignal) => Promise<unknown>;
		};

		expect(Object.keys(tool.parameters.properties)).toContain("group");
		// Naming neither reference is decided before anything is fetched, and the
		// answer names the parameter that takes a group.
		const result = await tool.execute("call1", {});
		expect(JSON.stringify(result)).toContain("Name exactly one of group");
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

	it("converts a thrown handler error into an error result, not a throw", async () => {
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

describe("assertInternalTools", () => {
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
	it("registers all exposed tools; only the third-party-effect ones carry optional:true", () => {
		const registered: Array<{ name: string; optional?: boolean }> = [];
		const api = {
			registerTool: vi.fn((_tool: unknown, opts?: { name?: string; optional?: boolean }) => {
				registered.push({ name: opts?.name ?? "?", optional: opts?.optional });
			}),
		} as unknown as Parameters<typeof registerRineTools>[0];

		registerRineTools(api, fakeCtx, { onboardContext: fakeCtx, tools: fullToolSet() });
		expect(registered.map((r) => r.name).sort()).toEqual([...EXPOSED_TOOLS].sort());
		for (const r of registered) {
			const expectOptional = OPTIONAL_TOOLS.has(r.name);
			expect(Boolean(r.optional)).toBe(expectOptional);
		}
		expect(registered.filter((r) => r.optional).map((r) => r.name).sort()).toEqual([
			"rine_fulfill",
			"rine_group_invite",
			"rine_group_reclaim",
			"rine_group_remove",
			"rine_group_vote",
			"rine_pay",
			"rine_send",
			"rine_send_and_wait",
		]);
	});

	it("routes every registered tool's result through stripCiphertext", async () => {
		// The group verbs return group/request/vote/removal rows that carry no
		// ciphertext field at all, but the guard is key-name-based and universal —
		// this asserts no tool is registered on a path that bypasses it.
		const captured: Array<{
			name: string;
			tool: { execute: (id: string, p: unknown) => Promise<unknown> };
		}> = [];
		const tools = [...EXPOSED_TOOLS, "rine_reply"].map((n) =>
			makeDef(n, async () => ({
				items: [{ id: "x", encrypted_payload: "CIPHER" }],
				self_encrypted_payload: "SELFCIPHER",
			})),
		);
		const api = {
			registerTool: vi.fn(
				(
					tool: { execute: (id: string, p: unknown) => Promise<unknown> },
					opts?: { name?: string },
				) => {
					captured.push({ name: opts?.name ?? "?", tool });
				},
			),
		} as unknown as Parameters<typeof registerRineTools>[0];

		registerRineTools(api, fakeCtx, { onboardContext: fakeCtx, tools });
		expect(captured).toHaveLength(EXPOSED_TOOLS.length);
		for (const c of captured) {
			const serialized = JSON.stringify(await c.tool.execute("call1", {}));
			expect(serialized).not.toContain("CIPHER");
			expect(serialized).not.toContain("encrypted_payload");
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

		registerRineTools(api, fakeCtx, { onboardContext: fakeCtx, tools });
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

		registerRineTools(api, fakeCtx, { onboardContext: fakeCtx, tools, autoPay: true });
		const pay = captured.find((c) => c.name === "rine_pay");
		await pay?.tool.execute("c", { message_id: "m1" });
		expect(seen.at(-1)).toEqual({ auto_pay: true, message_id: "m1" });
		await pay?.tool.execute("c", { message_id: "m1", auto_pay: false });
		expect(seen.at(-1)).toEqual({ auto_pay: false, message_id: "m1" }); // explicit override wins
	});

	it("hands rine_onboard the owner-capable context only on a fresh install, and every other tool the runtime one", async () => {
		const dirs = freshDirs();
		try {
			const seen = new Map<string, ToolContext>();
			const tools = [...EXPOSED_TOOLS, "rine_reply"].map((n) =>
				makeDef(n, async (ctx) => {
					seen.set(n, ctx);
					return {};
				}),
			);
			const captured: Array<{ name: string; tool: { execute: (id: string, p: unknown) => Promise<unknown> } }> = [];
			const api = {
				registerTool: vi.fn((tool: { execute: (id: string, p: unknown) => Promise<unknown> }, opts?: { name?: string }) => {
					captured.push({ name: opts?.name ?? "?", tool });
				}),
			} as unknown as Parameters<typeof registerRineTools>[0];
			const onboardCtx = { owner: true } as unknown as ToolContext;
			const runtimeCtx = { configDir: dirs.configDir, ownerDir: dirs.ownerDir } as ToolContext;

			registerRineTools(api, runtimeCtx, { tools, onboardContext: onboardCtx });
			for (const c of captured) await c.tool.execute("c", {});

			expect(seen.get("rine_onboard")).toBe(onboardCtx);
			for (const [name, ctx] of seen) {
				if (name !== "rine_onboard") expect(ctx).toBe(runtimeCtx);
			}
		} finally {
			dirs.dispose();
		}
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

/** The declared input properties of one installed mcp tool. */
function schemaProps(name: string): Record<string, unknown> {
	const def = mcpTools.find((t) => t.name === name);
	return (
		(def?.inputSchema as { properties?: Record<string, unknown> } | undefined)
			?.properties ?? {}
	);
}

/**
 * Exposed tools declaring an `agent` argument that is NOT the acting agent. Enumerated
 * rather than inferred: `agent` is the canonical actor spelling since the rename, so it
 * no longer separates an actor slot from a lookup target on its own.
 */
const NON_ACTOR_AGENT_TOOLS = ["rine_inspect"];

/** A def whose schema declares `key`, i.e. the shape the real mcp tool has. */
function makeActorDef(
	name: string,
	key: string,
	handler: ToolDef["handler"],
): ToolDef {
	return {
		...makeDef(name, handler),
		inputSchema: { type: "object", properties: { [key]: { type: "string" } } },
	};
}

describe("withActingAgent", () => {
	it("defaults the tool's own acting-agent argument, and an explicit value still wins", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const send = makeActorDef("rine_send", "agent", async (_ctx, p) => {
			seen.push(p);
			return {};
		});
		const bound = withActingAgent(send, "bot@acme.rine.network");
		await bound.handler(fakeCtx, { to: "peer@acme.rine.network" });
		expect(seen.at(-1)).toEqual({
			agent: "bot@acme.rine.network",
			to: "peer@acme.rine.network",
		});
		await bound.handler(fakeCtx, { agent: "other@acme.rine.network" });
		expect(seen.at(-1)).toEqual({ agent: "other@acme.rine.network" });
	});

	it("leaves a tool that takes no acting agent alone", () => {
		const pay = makeDef("rine_pay", async () => ({}));
		expect(withActingAgent(pay, "bot@acme.rine.network")).toBe(pay);
		const send = makeActorDef("rine_send", "agent", async () => ({}));
		expect(withActingAgent(send, undefined)).toBe(send); // unbound install ⇒ identity
	});

	it("never writes the acting agent into rine_group_invite's invitee argument", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const invite = makeActorDef("rine_group_invite", "agent", async (_ctx, p) => {
			seen.push(p);
			return {};
		});
		await withActingAgent(invite, "bot@acme.rine.network").handler(fakeCtx, {
			group_id: "g1",
			invitee: "invitee@acme.rine.network",
		});
		expect(seen.at(-1)).toEqual({
			agent: "bot@acme.rine.network",
			group_id: "g1",
			invitee: "invitee@acme.rine.network",
		});
	});

	it("fails loud when the tool stopped declaring its acting-agent argument (version skew)", () => {
		const stale = makeDef("rine_send", async () => ({}));
		expect(() => withActingAgent(stale, "bot@acme.rine.network")).toThrow(
			/acting-agent parameter "agent" — version skew/,
		);
	});

	it("binds every actor argument the installed mcp actually declares", () => {
		// The map is the plugin's only record of which argument each tool reads the
		// actor from; this holds it against the shipped mcp schemas so a rename there
		// cannot leave the plugin threading a dropped property.
		for (const name of ACTOR_TOOLS) {
			expect(schemaProps(name)).toHaveProperty("agent");
		}
	});

	it("finds the retired `as` spelling on no exposed tool", () => {
		// `as` was the actor on eleven group verbs. Nothing may still advertise it: a
		// tool that reintroduced it would be offering the model an argument this plugin
		// no longer knows how to fill, and the operator's binding would go to the
		// `agent` slot beside it while the model's value quietly won.
		for (const name of EXPOSED_TOOLS) {
			expect(schemaProps(name)).not.toHaveProperty("as");
		}
	});

	it("finds the retired `from` spelling on no exposed tool", () => {
		// The sends have converged on `agent`, which is what the old exact-set guard here
		// was written to go red on. `from` is still *read* by rine_send for a stale
		// caller, but a tool that declared it again would be offering the model a retired
		// word beside the canonical one — and two spellings the model can fill separately
		// is exactly the disagreement rine-mcp refuses.
		for (const name of EXPOSED_TOOLS) {
			expect(schemaProps(name)).not.toHaveProperty("from");
		}
	});

	it("classifies every exposed tool that declares an `agent` argument", () => {
		// What replaces the rest of that guard. It caught a newly-actor-taking tool by
		// the actor's unambiguous name; `agent` is now both the canonical actor and
		// rine_inspect's lookup target, so presence proves nothing either way and a
		// value-derived spelling set would demand rine_inspect be mapped as an actor
		// tool — asserting something false. The check is exhaustive instead: every
		// exposed tool declaring `agent` is either mapped as an actor tool or named as a
		// non-actor, and one that grows the argument is in neither list until somebody
		// says which it is.
		const declared = EXPOSED_TOOLS.filter((n) => "agent" in schemaProps(n));
		const classified = [...ACTOR_TOOLS, ...NON_ACTOR_AGENT_TOOLS];
		expect([...declared].sort()).toEqual([...classified].sort());
	});

	it("keeps rine_group_invite's actor and invitee arguments apart", () => {
		// The one tool whose `agent` changed meaning: it named the invitee and now names
		// the actor. No presence check can see that reassignment — the property exists
		// either way — so what pins it is `invitee` existing at all, because the agent
		// being invited has nowhere else to live. Swapping the map back onto the invitee
		// slot would invite this installation's own agent and report success.
		const props = schemaProps("rine_group_invite");
		expect(props).toHaveProperty("invitee");
		expect(props).toHaveProperty("invitees");
		expect(props).toHaveProperty("agent");
		expect(props).not.toHaveProperty("agents");
		expect(ACTOR_TOOLS.has("rine_group_invite")).toBe(true);
	});

	it("treats an actor argument the model left empty as unnamed", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const send = makeActorDef("rine_send", "agent", async (_ctx, p) => {
			seen.push(p);
			return {};
		});
		const bound = withActingAgent(send, "bot@acme.rine.network");

		await bound.handler(fakeCtx, { agent: "", to: "peer@acme.rine.network" });

		// An empty string names nobody: the operator's binding stands rather than
		// being discarded in favour of whatever the server would pick.
		expect(seen.at(-1)).toEqual({
			agent: "bot@acme.rine.network",
			to: "peer@acme.rine.network",
		});
	});

	it("stands aside for a retired spelling the model filled in", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const send = makeActorDef("rine_send", "agent", async (_ctx, p) => {
			seen.push(p);
			return {};
		});
		const bound = withActingAgent(send, "bot@acme.rine.network");

		await bound.handler(fakeCtx, { from: "other@acme.rine.network" });

		// `from` still names the actor to rine_send. Adding `agent` beside it would put
		// two disagreeing spellings of one value on the same rung, which rine-mcp
		// refuses — turning a caller's own choice into an error. Configuration is the
		// lower rung and loses silently.
		expect(seen.at(-1)).toEqual({ from: "other@acme.rine.network" });
	});

	it("reads `from` as an identity on the sends only, not on every actor tool", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const inbox = makeActorDef("rine_inbox", "agent", async (_ctx, p) => {
			seen.push(p);
			return {};
		});
		const bound = withActingAgent(inbox, "bot@acme.rine.network");

		await bound.handler(fakeCtx, { from: "other@acme.rine.network" });

		// `rine_inbox` declares no `from`, and nothing validates arguments it did
		// not declare. Reading one as "the caller chose an agent" would discard the
		// operator's binding and hand the choice back to the server — the host runs
		// several agents, so that is a different identity, not a default.
		expect(seen.at(-1)).toEqual({
			agent: "bot@acme.rine.network",
			from: "other@acme.rine.network",
		});
	});
});

describe("registerRineTools + agentId", () => {
	it("threads the configured agent into a registered tool call", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const tools = [...EXPOSED_TOOLS, "rine_reply"].map((n) => {
			const handler: ToolDef["handler"] = async (_ctx, p) => {
				seen.push({ tool: n, ...p });
				return {};
			};
			return ACTOR_TOOLS.has(n as (typeof EXPOSED_TOOLS)[number])
				? makeActorDef(n, "agent", handler)
				: makeDef(n, handler);
		});
		const captured: Array<{
			name: string;
			tool: { execute: (id: string, p: unknown) => Promise<unknown> };
		}> = [];
		const api = {
			registerTool: vi.fn(
				(
					tool: { execute: (id: string, p: unknown) => Promise<unknown> },
					opts?: { name?: string },
				) => {
					captured.push({ name: opts?.name ?? "?", tool });
				},
			),
		} as unknown as Parameters<typeof registerRineTools>[0];

		registerRineTools(api, fakeCtx, { onboardContext: fakeCtx, tools, agentId: "bot@acme.rine.network" });
		await captured
			.find((c) => c.name === "rine_group_join")
			?.tool.execute("c", { group_id: "g1" });
		expect(seen.at(-1)).toEqual({
			tool: "rine_group_join",
			agent: "bot@acme.rine.network",
			group_id: "g1",
		});

		// An install with no configured agent behaves exactly as before.
		registerRineTools(api, fakeCtx, { onboardContext: fakeCtx, tools });
		await captured
			.filter((c) => c.name === "rine_group_join")
			.at(-1)
			?.tool.execute("c", { group_id: "g1" });
		expect(seen.at(-1)).toEqual({ tool: "rine_group_join", group_id: "g1" });
	});
});
