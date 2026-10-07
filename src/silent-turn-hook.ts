import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isSilentReplyText } from "openclaw/plugin-sdk/reply-chunking";

/**
 * Sessions whose latest model call answered with the silent token (`NO_REPLY`), so that
 * `runtime-dispatch.ts`'s `deliver` can honour the model's decision to say nothing.
 *
 * The host does not: a direct chat resolves to a "required" reply, so a `NO_REPLY` after a tool
 * call is classed as a missing answer and the host runs an isolated finalization pass whose text
 * (or a canned fallback) reaches `deliver` in its place. Two agents that each close a deal with
 * `NO_REPLY` then answer each other's finalization text indefinitely.
 *
 * The set lives on `globalThis` because the handler and `deliver` run in different module
 * instances: the handler belongs to the discovery registry's load of this plugin (the one the
 * host's hook runner is built from), `deliver` to the full registry's.
 */
const STATE = Symbol.for("@rine-network/openclaw.silentSessions");
const silentSessions = ((globalThis as { [STATE]?: Set<string> })[STATE] ??= new Set<string>());

/** Whether the turn running on this session ended on a model answer of `NO_REPLY`. */
export function answeredSilently(sessionKey: string): boolean {
	return silentSessions.has(sessionKey);
}

/** Drop the record once its turn is over, so it cannot reach the next turn on the session. */
export function forgetSilentTurn(sessionKey: string): void {
	silentSessions.delete(sessionKey);
}

/**
 * Record, per session, whether the model's last answer was exactly `NO_REPLY`.
 *
 * Read from openclaw 2026.9.6's own dist, not assumed: `llm_output` fires at the end of every
 * model attempt with the attempt's `assistantTexts` and the session key in its context, except
 * for the host's isolated finalization pass (`operation === "settled-tool-finalization"`), so the
 * last event of a turn is the model's own answer and never the text the host wrote after it. It
 * is a conversation hook: a non-bundled plugin may register it only with
 * `plugins.entries.rine.hooks.allowConversationAccess`, and without that opt-in the host logs a
 * blocked-hook warning and this record stays empty, which leaves every answer delivered as before.
 *
 * Registered through the entry's `registerCapabilities` so it lands in the discovery registry.
 *
 * Each event overwrites the session's record, so a turn that did not end silent clears it.
 */
export function registerSilentTurnHook(api: OpenClawPluginApi): void {
	api.on("llm_output", (event, ctx) => {
		if (!ctx.sessionKey) return;
		if (isSilentReplyText(event.assistantTexts.at(-1))) {
			silentSessions.add(ctx.sessionKey);
		} else {
			silentSessions.delete(ctx.sessionKey);
		}
	});
}
