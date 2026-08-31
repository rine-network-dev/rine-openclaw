import { ACTOR_SURFACES } from "@rine-network/core";
import { actorKeysFor, namesActor } from "@rine-network/mcp/tools";
import type { ToolDef } from "@rine-network/mcp/tools";
import type { EXPOSED_TOOLS } from "./tools.js";

type ExposedTool = (typeof EXPOSED_TOOLS)[number];

/**
 * The exposed tools that take an acting agent.
 *
 * A set rather than a per-tool spelling: rine-mcp spells the concept `agent` on every one
 * of them, sends included, so the map's values had collapsed to one word and the only
 * thing left to record is membership. The retired spellings (`as`, and `from` on the two
 * sends) are still *read* by rine-mcp, but nothing here writes them — a wrapper that
 * defaulted a retired word would put it back in front of the model.
 *
 * A tool absent from this set takes no acting agent at all. Where such a tool has an
 * `agent`-shaped argument it means something else: `rine_inspect`'s `agent` is the
 * agent being looked up, `rine_onboard`'s `agent_name` names the agent being created,
 * and `rine_pay`/`rine_fulfill` derive the payee from the quote's own addressee.
 *
 * `rine_group_invite` is the tool the rename moved. Its `agent` used to be the
 * **invitee** and is now the actor, the invitee having taken its own `invitee` /
 * `invitees` slots. No presence check can tell those two readings apart — the property
 * exists either way — so the pair is pinned against the shipped schema by test, and
 * what makes that test meaningful is `invitee` existing at all: the invitee has
 * nowhere else to live. Swapping them would invite the installation's own agent and
 * report success.
 */
export const ACTOR_TOOLS: ReadonlySet<ExposedTool> = new Set<ExposedTool>([
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
]);

/** The one word this plugin writes the acting agent into, as rine-mcp declares it. */
const ACTOR_KEY = ACTOR_SURFACES.mcp.canonical;

/** Throw on a tool in {@link ACTOR_TOOLS} that no longer declares `agent`. */
function assertDeclaresActor(def: ToolDef): void {
	const props = (def.inputSchema as { properties?: Record<string, unknown> }).properties;
	if (props === undefined || !(ACTOR_KEY in props)) {
		throw new Error(
			`rine: mcp tool "${def.name}" no longer declares its acting-agent parameter ` +
				`"${ACTOR_KEY}" — version skew`,
		);
	}
}

/**
 * Bind the acting agent this install is configured for (`channels.rine.agentId`) as the
 * default of the tool's own acting-agent argument. Without it the plugin emits
 * `X-Rine-Agent` on no tool call at all, so a host running several agents acts as
 * whichever one the org's single-agent shortcut picks — or fails to resolve one.
 *
 * The operator's string travels **unresolved**: rine-mcp accepts a name, handle or UUID
 * and resolves it per call. This is the tool-facing half of `channels.rine.agentId`, and
 * it is not the same object as the notify service's binding — `resolveBoundAgentId`
 * turns the same setting into one UUID, up front, for the inbox the transports read.
 *
 * A model-supplied value still wins, so the operator's binding is a default and not a
 * cap — but an empty string names nobody, and letting one through would discard the
 * binding and hand the choice straight back to the server. 🔴 "Did the model name one?"
 * is rine-mcp's question to answer, not this file's: it reads retired spellings this
 * plugin never writes, and defaulting `agent` beside a model-supplied `from` would turn
 * one caller's choice into a two-values refusal. Configuration is a lower rung than the
 * call, and a lower rung loses silently.
 *
 * Mirrors {@link withAutoPayDefault}: one argument re-defaulted, nothing else touched. A
 * tool with no acting-agent argument is returned unchanged, and a tool whose argument has
 * disappeared upstream throws at load rather than silently dropping the actor — the
 * same version-skew posture as `requireTool`.
 */
export function withActingAgent(def: ToolDef, agentId: string | undefined): ToolDef {
	if (agentId === undefined) return def;
	if (!ACTOR_TOOLS.has(def.name as ExposedTool)) return def;
	assertDeclaresActor(def);
	return {
		...def,
		handler: (ctx, params) => {
			const args = { ...(params ?? {}) };
			// The keys THIS tool reads, not the widest set: `from` is an identity
			// on the two sends and on nothing else, so a `from` a model invented
			// on `rine_inbox` must not read as "the caller chose an agent" and
			// discard the operator's binding.
			if (!namesActor(args, actorKeysFor(def.name))) args[ACTOR_KEY] = agentId;
			return def.handler(ctx, args);
		},
	};
}
