import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createSendGuard } from "./send-guard.js";

/**
 * Wire the repeat-send guard onto the host's `before_tool_call` and `after_tool_call` hooks.
 *
 * Read from openclaw 2026.9.6's own dist, not assumed: the host wraps EVERY tool a run can
 * call, ours included, and runs the hook with a `runId` on every agent attempt. A
 * `{ block, blockReason }` result never reaches `execute`; the model is handed `blockReason`
 * as the tool's text result (`buildBlockedToolResult`).
 *
 * `after_tool_call` fires for every call the host settled, and carries `error` whenever the call
 * threw, was blocked by another hook, or returned an error-shaped result — which is how this
 * plugin's own tools report a failed send (`toOpenClawTool` folds a throw into `{ error }`). The
 * guard releases such a call's key so the identical retry is not told the message already went out.
 * It is not one of the conversation-gated hooks, so it needs no operator opt-in.
 *
 * An allowed call is rewritten to carry the guard's idempotency key (`{ params }` is shallow-merged
 * over the call's own params, so only that key is returned). The server keys idempotency on the
 * sending agent, so a retry of a call that may already have been delivered, released above on any
 * host-reported error, comes back as the original message instead of a second one. That holds only
 * while our key reaches the call: the host keeps the last `params` any `before_tool_call` returns,
 * so another plugin that rewrites this tool's params after ours drops the key, and a released retry
 * of a delivered send can then go out twice.
 *
 * A model that reaches `rine_send` through the host's deferred `tool_call` wrapper is guarded the
 * same way: the host runs the hook on the wrapped tool itself (`toolName` is `rine_send`, with the
 * run's `runId`), so no unwrapping is needed here.
 *
 * Registered through the entry's `registerCapabilities` so it lands in the discovery registry, the
 * one the host's hook runner is built from. Its state is the closure below, shared by the three
 * handlers of that one registration, so it needs no module-level or global state.
 *
 * The host runs `before_tool_call` fail-closed — a throwing handler blocks the tool — so a
 * defect in the guard must not turn into "the agent can no longer send": it allows the call.
 *
 * `session_end` is the only end-of-life signal registered. `agent_end` is a conversation hook
 * that non-bundled plugins may register only with `plugins.entries.rine.hooks.allowConversationAccess`,
 * and registering it without that opt-in logs a blocked-hook warning on every start; the
 * guard's TTL bounds its memory instead.
 */
export function registerSendGuard(api: OpenClawPluginApi): void {
	const guard = createSendGuard();
	api.on("before_tool_call", (event, ctx) => {
		const runId = event.runId ?? ctx.runId;
		if (!runId) return undefined;
		try {
			const verdict = guard.check(
				runId,
				event.toolName,
				event.params,
				ctx.sessionKey,
				event.toolCallId ?? ctx.toolCallId,
			);
			if (!verdict) return undefined;
			if (verdict.block) return { block: true, blockReason: verdict.reason };
			return verdict.idempotencyKey === event.params.idempotency_key
				? undefined
				: { params: { idempotency_key: verdict.idempotencyKey } };
		} catch {
			return undefined;
		}
	});
	api.on("after_tool_call", (event, ctx) => {
		const runId = event.runId ?? ctx.runId;
		const toolCallId = event.toolCallId ?? ctx.toolCallId;
		if (runId && toolCallId) guard.settle(runId, toolCallId, event.error !== undefined);
	});
	api.on("session_end", (event) => {
		if (event.sessionKey) guard.forgetSession(event.sessionKey);
	});
}
