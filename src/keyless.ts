import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

/**
 * The one loud line an operator gets when this agent holds no key material at
 * all, and the latch that keeps it to one.
 *
 * The gap it closes: a mis-keyed agent was **completely silent**. Every inbound
 * envelope classifies `no-keys`, every one is parked by `dispatch.ts`, no turn
 * ever fires, and the only thing said about it was the ordinary set-aside line at
 * INFO — which reads as routine, because for every other verdict it is. So the
 * channel connected, reported healthy and never answered, and nothing anywhere
 * said why.
 *
 * 🔴 The parking stays. Waking the harness instead would hand a model ciphertext
 * it cannot open, and a model handed that produces a confident non-answer; the
 * runtime deciding readability before the harness is woken is the whole policy
 * this sits inside. What was missing was not a different action, it was a signal.
 *
 * 🔴 ONCE per agent, not once per message. A keyless agent receives *every*
 * message into this arm, so a per-message ERROR is precisely the log storm the
 * attempt bound exists to prevent. The latch is the `quarantined` Set's
 * reasoning with one id instead of many: it lives in the `onMessage` closure,
 * which `service.ts` builds one of per notify loop per agent, and it is
 * deliberately NOT subject to the hourly `seen.clear()` — a second sighting of
 * the same broken install is not news.
 *
 * The sentence is built by interpolation and never by `path.join`. It is a
 * string for a human to read and is never handed to a filesystem call, and
 * `join` throws on a non-string — this runs on the inbound path, inside a
 * best-effort log, and a config dir this plugin was handed is not something
 * that path gets to assume (the same trap `sidecar.ts` computes its paths inside
 * the guard for).
 */

/** What the announcement needs in order to name the agent and the directory. */
export interface KeylessAnnounceArgs {
	readonly logger: PluginLogger;
	/**
	 * The resolved rine config dir — `RINE_CONFIG_DIR`, `~/.config/rine` or
	 * `$PWD/.rine`. It is named in full deliberately: the `sidecar.ts` convention
	 * of logging a prefix rather than a path is about lines an operator never has
	 * to act on, and this is the opposite of one. A bare "unreadable" is what made
	 * this class invisible, so a line that names no directory and no agent
	 * diagnoses nothing.
	 */
	readonly configDir: string;
	readonly agentId: string;
}

/**
 * What the operator is told: which agent, which directory, which two files, what
 * is happening to their mail meanwhile, and what to do about it.
 *
 * Private: the announcer below is the only way to say it, so the latch cannot be
 * bypassed by a caller that reaches for the words directly.
 */
function keylessAgentLine(configDir: string, agentId: string): string {
	return (
		`rine: agent ${agentId} holds NO key material in ${configDir} — ` +
		`expected ${configDir}/keys/${agentId}/signing.key and encryption.key. ` +
		`Every inbound message is therefore unreadable and is being set aside ` +
		`instead of waking a turn, so this channel connects, reports healthy and ` +
		`never answers. Restore that key directory, or point ` +
		`channels.rine.agentId at an agent this config dir does hold keys for, or ` +
		`onboard a fresh agent (rine_onboard). Restoring the key files needs no ` +
		`restart: the next inbound is dispatched normally, and every parked ` +
		`message still inside its five retries is swept up within five minutes. ` +
		`Changing channels.rine.agentId is configuration and takes effect on a ` +
		`Gateway restart. Nothing has been lost meanwhile — no set-aside message ` +
		`was marked delivered, so rine_inbox lists them all and rine_read ` +
		`fetches them.`
	);
}

/**
 * Hand back the once-only announcement for one agent.
 *
 * A factory returning a function, the `startSweepSchedule` shape: there is one
 * thing to ask for, asking twice is free, and the state that makes it once-only
 * belongs to the caller's lifetime rather than to the module — two agents on one
 * host each get their own latch, and a restarted channel says it again.
 */
export function keylessAnnouncer(a: KeylessAnnounceArgs): () => void {
	let said = false;
	return () => {
		if (said) return;
		said = true;
		a.logger.error(keylessAgentLine(a.configDir, a.agentId));
	};
}
