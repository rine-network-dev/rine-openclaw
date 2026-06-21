import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import { tools as mcpTools } from "@rine-network/mcp/tools";
import type { ToolContext, ToolDef } from "@rine-network/mcp/tools";
import { INTERNAL_TOOLS } from "./constants.js";

/** Tools exposed by the plugin (filtered from the mcp tool array). */
export const EXPOSED_TOOLS = [
	"rine_whoami",
	"rine_discover",
	"rine_send",
	"rine_read",
	"rine_inbox",
	"rine_thread",
	"rine_onboard",
] as const;

/** Mutating tools gated behind the allowlist (manifest `toolMetadata.optional`). */
export const OPTIONAL_TOOLS = new Set<string>(["rine_send", "rine_onboard"]);

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

/** Filter mcp tools to the exposed set; fail loud on a missing name (version skew). */
export function selectExposedTools(all: ToolDef[] = mcpTools): ToolDef[] {
	const byName = new Map(all.map((t) => [t.name, t]));
	return EXPOSED_TOOLS.map((name) => requireTool(byName, name, all));
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
 * verbatim (no TypeBox validation — see SDK_CONTRACT.md), so the whole tool object
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
 * Register the exposed rine tools on the plugin api. `rine_send`/`rine_onboard`
 * are registered `{ optional: true }` (allowlist gating per manifest toolMetadata).
 * Internal deps (`rine_reply`) are validated here too so version skew fails at load.
 */
export function registerRineTools(api: OpenClawPluginApi, ctx: ToolContext): void {
	assertInternalTools();
	for (const def of selectExposedTools()) {
		const opts = OPTIONAL_TOOLS.has(def.name)
			? { name: def.name, optional: true }
			: { name: def.name };
		api.registerTool(toOpenClawTool(def, ctx), opts);
	}
}
