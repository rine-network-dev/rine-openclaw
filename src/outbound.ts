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

/**
 * Active send of an agent reply/message to an arbitrary rine target, reusing the
 * lifted `rine_send` handler (E2EE encrypt + POST /messages). Backs the channel
 * `outbound.sendText` adapter so OpenClaw's generic `send` message-action resolves
 * and delivers (without this the channel had no outbound surface — the agent's
 * generic send failed with `Unknown target … for rine`).
 *
 * `agent` (the sending agent, by name, handle or UUID) is passed only when configured;
 * without it `rine_send` climbs its own ladder — `RINE_AGENT`, then the org's sole
 * agent — and refuses in a multi-agent org rather than guessing. It was spelled `from`
 * here until the rename; `rine_send` still reads that word from a stale caller, but
 * nothing in this plugin writes it.
 */
export async function sendRineText(
	client: RineClient,
	to: string,
	text: string,
	agent?: string,
): Promise<{ messageId: string }> {
	const send = toolByName("rine_send");
	const res = (await send.handler(client.toolContext, {
		to,
		payload: { text },
		...(agent ? { agent } : {}),
	})) as { id?: string; message_id?: string } | undefined;
	return { messageId: res?.id ?? res?.message_id ?? "unknown" };
}
