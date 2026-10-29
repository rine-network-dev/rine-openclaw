import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { GUARDED_SEND_TOOLS } from "./send-guard.js";
import { claimRun, recordSend } from "./tool-answers.js";

/** The payload a tool returned: the host's `details`, else the JSON text of its content. */
function payloadOf(result: unknown): Record<string, unknown> | undefined {
	const wrapped = result as { details?: unknown; content?: { text?: unknown }[] } | undefined;
	if (wrapped?.details && typeof wrapped.details === "object") {
		return wrapped.details as Record<string, unknown>;
	}
	const text = wrapped?.content?.[0]?.text;
	if (typeof text !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** The 1:1 recipient a send payload names: on the message itself, or inside a sync response. */
function recipientOf(payload: Record<string, unknown>): string | undefined {
	const inner = payload.message;
	const nested = inner && typeof inner === "object" ? (inner as Record<string, unknown>) : {};
	const handle = payload.recipient_handle ?? nested.recipient_handle;
	return typeof handle === "string" && handle ? handle : undefined;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Record, per session and run, the conversations, groups and peers the model's send tools
 * delivered to, and bind each host run to the turn it was woken for.
 *
 * `after_tool_call` carries `error` whenever the call threw or was blocked, and this plugin's
 * tools fold a throw into an `{ error }` payload, so both shapes are skipped. A successful
 * `rine_send` returns the posted message and `rine_send_and_wait` the sync response; both carry
 * `conversation_id` at the top level, a group post carries `group_handle` and a 1:1 post
 * `recipient_handle` (on the sync response, inside `message`). The hook is not one of the
 * conversation-gated hooks, so it needs no operator opt-in.
 *
 * `llm_input` is one: a non-bundled plugin may register it only with
 * `plugins.entries.rine.hooks.allowConversationAccess`. It is what tells a run which inbound
 * message it answers. Without the opt-in the host logs a blocked-hook warning and runs stay
 * unclaimed, so a record is attributed only while a single turn runs on its session.
 *
 * Registered through the entry's `registerCapabilities` so it lands in the discovery registry.
 */
export function registerToolAnswerHook(api: OpenClawPluginApi): void {
	api.on("llm_input", (event, ctx) => {
		if (ctx.sessionKey) claimRun(ctx.sessionKey, event.runId, event.prompt);
	});
	api.on("after_tool_call", (event, ctx) => {
		if (!ctx.sessionKey || event.error !== undefined) return;
		if (!GUARDED_SEND_TOOLS.has(event.toolName)) return;
		const payload = payloadOf(event.result);
		if (!payload || payload.error !== undefined) return;
		recordSend(ctx.sessionKey, event.runId ?? ctx.runId, {
			conversationId: text(payload.conversation_id),
			groupHandle: text(payload.group_handle),
			peerHandle: recipientOf(payload),
		});
	});
}
