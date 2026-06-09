import { tools as mcpTools } from "@rine-network/mcp/tools";
import type { ToolDef } from "@rine-network/mcp/tools";
import type { RineClient } from "./rine-client.js";
import type { RineInbound } from "./types.js";

function toolByName(name: string, all: ToolDef[] = mcpTools): ToolDef {
	const def = all.find((t) => t.name === name);
	if (!def) {
		throw new Error(`rine: required mcp tool "${name}" not found — version skew`);
	}
	return def;
}

/**
 * Route an agent reply back out as a rine message, reusing the lifted `rine_reply`
 * handler (E2EE encrypt + POST /messages/{id}/reply, auto-routed to the original
 * sender, conversation_id preserved). No crypto/HTTP reimplemented.
 */
export async function sendRineReply(
	client: RineClient,
	inbound: RineInbound,
	text: string,
): Promise<unknown> {
	const reply = toolByName("rine_reply");
	return reply.handler(client.toolContext, {
		message_id: inbound.id,
		payload: { text },
	});
}
