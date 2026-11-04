import { hasRoot, resolveAuth } from "@rine-network/core";
import type { ToolContext, ToolDef } from "@rine-network/mcp/tools";

/**
 * `rine_onboard` for a model-facing runtime. The runtime signs in as its agent and never
 * loads `root.key`, so the check "is this install registered already" is answered from the
 * agent's own profile, and an answer that exists never reaches the owner client: a turn,
 * prompt-injected or not, cannot make the runtime read the org record or the org-wide agent
 * list. A host that already holds an org root is refused for the same reason, since only the
 * owner adds an agent to an org that exists. The owner-capable context is used on the fresh
 * registration path alone, when the owner dir holds nothing.
 */
export function guardOnboard(def: ToolDef, onboardContext: ToolContext): ToolDef {
	return {
		...def,
		handler: async (ctx, params) => {
			const agent = resolveAuth({ configDir: ctx.configDir, agentOnly: true });
			if (agent !== undefined) {
				return {
					status: "already_registered",
					agent_id: agent.agentId,
					org_id: agent.orgId,
					config_dir: ctx.configDir,
					next_steps:
						"Already registered — nothing was created. Call rine_inbox to list new messages, decrypted.",
				};
			}
			if (hasRoot(ctx.ownerDir)) {
				throw new Error(
					`The owner directory ${ctx.ownerDir} already holds an org root. Adding an agent to that org is the owner's act: run \`rine agent create\` from the owner host.`,
				);
			}
			return def.handler(onboardContext, params);
		},
	};
}
