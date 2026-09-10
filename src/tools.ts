import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import { tools as mcpTools } from "@rine-network/mcp/tools";
import type { ToolContext, ToolDef } from "@rine-network/mcp/tools";
import { INTERNAL_TOOLS } from "./constants.js";
import { withActingAgent } from "./tool-actor.js";

/** Tools exposed by the plugin (filtered from the mcp tool array). */
export const EXPOSED_TOOLS = [
	"rine_whoami",
	"rine_discover",
	"rine_inspect",
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
	"rine_send",
	"rine_send_and_wait",
	"rine_read",
	"rine_inbox",
	"rine_thread",
	"rine_onboard",
	"rine_pay",
	"rine_fulfill",
] as const;

/**
 * Tools with an irreversible external effect ON A THIRD PARTY, gated behind the operator's
 * tool allowlist. The manifest's `toolMetadata.optional` carries the same set — OpenClaw ORs
 * the two, so both must agree. `rine_send` and `rine_send_and_wait` speak to a third party
 * over an encrypted channel — the second one is a send like any other, and the reply it waits
 * for does not make the message it already delivered take-backable;
 * `rine_pay` moves funds and `rine_fulfill` settles on-chain.
 *
 * `rine_group_invite`, `rine_group_vote`, `rine_group_remove` and `rine_group_reclaim` join
 * them for the same reason. An invite acts on the group's roster on membership alone: the
 * server authorises it with read access rather than admin on every policy but `closed`. On
 * a closed group it hands the named agent a seat it can redeem straight away, together with
 * a ratchet-tree leaf and Welcome minted inside the same call; on a majority or unanimity
 * group it files a join request in the group's name and spends this host's own approval on
 * it, and the electorate decides. An approve that crosses a group's threshold hands a
 * stranger the group's keys and cannot be taken back. A remove evicts somebody else — on an
 * MLS group it posts a Remove commit that takes their ratchet-tree leaf and that every
 * member downloads at O(N). Reclamation posts one Remove commit per orphaned leaf, and an
 * agent whose invitation lapsed and who is re-invited between the tree read and the commit
 * loses the fresh leaf with them.
 *
 * Note the asymmetry with the ungated `rine_group_sync`, whose expensive rung also costs
 * the group O(N): the criterion is an irreversible effect on a THIRD PARTY, not cost.
 *
 * Every other group verb is offered under the default empty allowlist, on the same reasoning
 * that keeps `rine_onboard` out of this set: gating a tool the plugin's core function depends
 * on leaves a fresh agent unable to work. An agent that cannot create, discover, join or read
 * a group is not a group participant at all, and an operator would have to edit the allowlist
 * before the plugin did anything with groups. Note the asymmetry with `rine_group_leave`,
 * which is irreversible but acts only on THIS host: gating it would leave an agent unable to
 * get out of a group somebody else put it in.
 *
 * `rine_onboard` is deliberately absent: registering the org is the first thing an
 * uncredentialed install does, and on an install that already holds credentials the tool
 * returns the existing org and writes nothing. Gating it leaves a fresh agent unable to
 * register itself.
 */
export const OPTIONAL_TOOLS = new Set<string>([
	"rine_send",
	"rine_send_and_wait",
	"rine_pay",
	"rine_fulfill",
	"rine_group_invite",
	"rine_group_vote",
	"rine_group_remove",
	"rine_group_reclaim",
]);

/**
 * Payee tools exposed only when the installed mcp actually provides them. `rine_fulfill`
 * ships in the mcp minor that lands the payee path; every PUBLISHED openclaw pins an mcp
 * `^`-range that includes it, so real installs always expose it. This lenience only covers
 * the version window where a locally-linked mcp predates the payee tool — it never masks a
 * skew of a tool openclaw's core function depends on (those stay strict via `requireTool`).
 *
 * The group verbs are deliberately NOT lenient. `publish-package.sh` rewrites the `file:`
 * mcp dep to a `^`-range on mcp's current version, so a published openclaw can never resolve
 * an mcp without them; lenience would only take effect against a locally-linked older mcp,
 * where it would let the plugin load with the group surface silently missing and every gate
 * still green. That fake-green is the failure this set exists to avoid, not to create.
 */
const LENIENT_TOOLS = new Set<string>(["rine_fulfill"]);

const CIPHERTEXT_KEYS = ["encrypted_payload", "self_encrypted_payload"] as const;

/**
 * Strip raw ciphertext from any tool result before it reaches a transcript.
 * Recurses through objects/arrays so `rine_read`/`rine_inbox` (which spread the
 * raw `MessageRead`) never surface `encrypted_payload`. Plaintext lives on the
 * `decrypted`/`verified` fields the mcp handlers add.
 */
export function stripCiphertext(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((v) => stripCiphertext(v));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if ((CIPHERTEXT_KEYS as readonly string[]).includes(k)) continue;
			out[k] = stripCiphertext(v);
		}
		return out;
	}
	return value;
}

/** Assert one mcp tool name is present; throw a version-skew error otherwise. */
function requireTool(byName: Map<string, ToolDef>, name: string, all: ToolDef[]): ToolDef {
	const def = byName.get(name);
	if (!def) {
		throw new Error(
			`rine: expected mcp tool "${name}" not found in @rine-network/mcp/tools (got: ${all
				.map((t) => t.name)
				.join(", ")}) — version skew`,
		);
	}
	return def;
}

/**
 * Filter mcp tools to the exposed set; fail loud on a missing name (version skew). A
 * {@link LENIENT_TOOLS} entry absent from the installed mcp is skipped (not thrown) so a
 * locally-linked mcp that predates the payee tool still loads — everything else is strict.
 */
export function selectExposedTools(all: ToolDef[] = mcpTools): ToolDef[] {
	const byName = new Map(all.map((t) => [t.name, t]));
	const out: ToolDef[] = [];
	for (const name of EXPOSED_TOOLS) {
		if (LENIENT_TOOLS.has(name) && !byName.has(name)) continue;
		out.push(requireTool(byName, name, all));
	}
	return out;
}

/**
 * Validate the undeclared internal tools the plugin relies on (e.g. `rine_reply`,
 * which backs the inbound→reply path). Throws at startup on a version skew so a rename
 * of an mcp tool fails fast at load — not silently at first reply.
 */
export function assertInternalTools(all: ToolDef[] = mcpTools): void {
	const byName = new Map(all.map((t) => [t.name, t]));
	for (const name of INTERNAL_TOOLS) requireTool(byName, name, all);
}

/**
 * Adapt one mcp ToolDef into an OpenClaw AnyAgentTool with ciphertext stripping.
 * `parameters` is rine-mcp's JSON-schema `inputSchema`; `registerTool` stores it
 * verbatim and validates none of it against TypeBox, so the whole tool object
 * is cast to `AnyAgentTool` at one documented seam. (typebox is a transitive dep of
 * openclaw, not directly importable, so we never reference its `TSchema` type.)
 *
 * A thrown handler (e.g. an optional tool called on a headless install, or a transient
 * API failure) is converted into an actionable `jsonResult` error string — the agent
 * gets a result it can reason about instead of the turn crashing or hanging.
 */
export function toOpenClawTool(def: ToolDef, ctx: ToolContext): AnyAgentTool {
	const tool = {
		name: def.name,
		label: def.name,
		description: def.description,
		parameters: def.inputSchema,
		execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
			signal?.throwIfAborted();
			try {
				const result = await def.handler(
					ctx,
					(params ?? {}) as Record<string, unknown>,
				);
				return jsonResult(stripCiphertext(result));
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") throw err;
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ error: `rine: ${def.name} failed: ${message}` });
			}
		},
	};
	return tool as unknown as AnyAgentTool;
}

/**
 * Opt-in auto-pay. When `channels.rine.payments.autoPay` is true, the exposed
 * `rine_pay` tool defaults its `auto_pay` argument to `true` — so a call that omits the
 * argument pays only at/below the wallet policy's `autoPayThreshold` (and returns
 * `above-auto-pay-threshold` otherwise). The model may still pass `auto_pay: false`
 * explicitly to override. Default OFF leaves the shipped explicit-authorization semantics
 * untouched. The wrapper only re-defaults one argument — the caps, deny-by-default policy,
 * journal and reserve-lock all stay in rine-core, unchanged.
 */
export function withAutoPayDefault(def: ToolDef, autoPay: boolean): ToolDef {
	if (!autoPay || def.name !== "rine_pay") return def;
	return {
		...def,
		handler: (ctx, params) => def.handler(ctx, { auto_pay: true, ...(params ?? {}) }),
	};
}

/** Options for {@link registerRineTools}. `tools` is a test seam (defaults to mcpTools). */
export interface RegisterToolsOptions {
	autoPay?: boolean;
	/** The agent this install acts as (`channels.rine.agentId`), named on every tool call that takes one. */
	agentId?: string;
	tools?: ToolDef[];
}

/**
 * Register the exposed rine tools on the plugin api. The {@link OPTIONAL_TOOLS} register
 * `{ optional: true }`, so OpenClaw offers them only when the agent's tool allowlist names
 * them; every other tool — `rine_onboard` included — is offered under the default empty
 * allowlist. Internal deps (`rine_reply`) are validated here too so version skew fails at
 * load. With `opts.autoPay`, `rine_pay` is threshold-gated by default; with `opts.agentId`,
 * every tool that declares an acting-agent argument defaults it to that agent (see
 * {@link withActingAgent}). What each tool then does with the argument is rine-mcp's:
 * nearly all of them send it as `X-Rine-Agent`, while `rine_read` reads it only to pick
 * the identity it decrypts as and sends no header of its own.
 */
export function registerRineTools(
	api: OpenClawPluginApi,
	ctx: ToolContext,
	opts: RegisterToolsOptions = {},
): void {
	assertInternalTools(opts.tools);
	for (const def of selectExposedTools(opts.tools)) {
		const tuned = withActingAgent(
			withAutoPayDefault(def, opts.autoPay === true),
			opts.agentId,
		);
		const regOpts = OPTIONAL_TOOLS.has(def.name)
			? { name: def.name, optional: true }
			: { name: def.name };
		api.registerTool(toOpenClawTool(tuned, ctx), regOpts);
	}
}
