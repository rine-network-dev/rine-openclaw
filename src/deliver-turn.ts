import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { msgOf } from "./err.js";
import { sendRineReply, sendRineText } from "./outbound.js";
import type { RineClient } from "./rine-client.js";
import { toolAnswer, type Turn } from "./tool-answers.js";
import type { RineInbound } from "./types.js";

/** Where an agent's turn is delivered: to the whole group, or back to the sender. */
export type AnswerRoute = { kind: "group" | "direct"; handle: string };

/** What `deliverTurn` needs to decide whether, and where, a turn's text goes. */
type TurnDelivery = {
	msg: RineInbound;
	suppressed: string | undefined;
	route: AnswerRoute | undefined;
	turn: Turn;
	client: RineClient;
	logger: PluginLogger;
	agentId: string;
};

/** The host's `deliver` for one turn: apply every reason to stay silent, else answer. */
export async function deliverTurn(text: string, d: TurnDelivery): Promise<void> {
	const { msg, suppressed, route, turn, client, logger, agentId } = d;
	if (!text) {
		// rine replies are text-only; a media-only turn (channel declares
		// media:false, so this is near-unreachable) is dropped — but logged.
		logger.warn(`rine: dropping non-text reply for ${msg.id} (rine replies are text-only)`);
		return;
	}
	if (suppressed) {
		logger.debug?.(
			`rine: no auto-reply for ${msg.type} ${msg.id} (${suppressed})`,
		);
		return;
	}
	// The model chose silence; the host's finalization pass wrote this text over it.
	if (turn.silent) {
		logger.debug?.(
			`rine: no auto-reply for ${msg.type} ${msg.id} (the model answered NO_REPLY)`,
		);
		return;
	}
	// The model already sent its answer through a tool; the final text would repeat it.
	const answered = toolAnswer(turn, {
		conversationId: msg.conversationId,
		groupHandle: msg.groupHandle,
		peerHandle: msg.isGroup ? undefined : msg.fromHandle,
	});
	if (answered) {
		logger.info(`rine: no auto-reply for ${msg.type} ${msg.id} (${answered})`);
		return;
	}
	if (!route) {
		logger.error(
			`rine: cannot answer group message ${msg.id} — inbound carries no group handle`,
		);
		return;
	}
	await deliverAnswer(client, msg, route, text, logger, agentId);
}

/**
 * Route one agent turn back out to its audience. A group answer is a broadcast through the
 * lifted `rine_send` handler — the same call `channel.ts`'s outbound adapter already makes,
 * so no crypto or HTTP is reimplemented and the auto-answer does not become allowlist-gated
 * (the handler is invoked directly, never offered to the model). A 1:1 answer keeps the
 * reply-in-place path, which preserves the conversation.
 */
async function deliverAnswer(
	client: RineClient,
	msg: RineInbound,
	route: AnswerRoute,
	text: string,
	logger: PluginLogger,
	agentId: string,
): Promise<void> {
	try {
		if (route.kind === "group") {
			await sendRineText(client, route.handle, text, agentId);
			return;
		}
		await sendRineReply(client, msg, text);
	} catch (err) {
		logger.error(`rine: outbound reply failed for ${msg.id}: ${msgOf(err)}`);
	}
}
