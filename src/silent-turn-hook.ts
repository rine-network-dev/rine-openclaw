import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isSilentReplyText } from "openclaw/plugin-sdk/reply-chunking";
import { recordModelAnswer } from "./tool-answers.js";

/**
 * Record, per turn, whether the model's last answer was exactly `NO_REPLY`, so that
 * `deliver-turn.ts` can honour the model's decision to say nothing.
 *
 * The host does not: a direct chat resolves to a "required" reply, so a `NO_REPLY` after a tool
 * call is classed as a missing answer and the host runs an isolated finalization pass whose text
 * (or a canned fallback) reaches `deliver` in its place. Two agents that each close a deal with
 * `NO_REPLY` then answer each other's finalization text indefinitely.
 *
 * Read from openclaw 2026.9.6's own dist, not assumed: `llm_output` fires at the end of every
 * model attempt with the attempt's `assistantTexts`, its `runId` and the session key in its
 * context, except for the host's isolated finalization pass
 * (`operation === "settled-tool-finalization"`), so the last event of a turn is the model's own
 * answer and never the text the host wrote after it. The run id is what attributes the answer to
 * its turn (`tool-answers.ts`), because two turns of one peer share a session. It is a
 * conversation hook: a non-bundled plugin may register it only with
 * `plugins.entries.rine.hooks.allowConversationAccess`, and without that opt-in the host logs a
 * blocked-hook warning and no turn is ever marked, which leaves every answer delivered as before.
 *
 * Registered through the entry's `registerCapabilities` so it lands in the discovery registry.
 *
 * Each event overwrites its turn's mark, so a turn that did not end silent clears it.
 */
export function registerSilentTurnHook(api: OpenClawPluginApi): void {
	api.on("llm_output", (event, ctx) => {
		if (!ctx.sessionKey) return;
		recordModelAnswer(ctx.sessionKey, event.runId, isSilentReplyText(event.assistantTexts.at(-1)));
	});
}
