import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { keylessAnnouncer } from "./keyless.js";
import { recordSetAside, type SetAsideReason } from "./setaside.js";
import type { RineInbound } from "./types.js";

/**
 * What the inbound path does with a message this agent could not open: record it in the
 * set-aside store, say so once, and leave it in the rine inbox for the retry sweep.
 * Split out of `dispatch.ts` for the file-size budget; the control flow that decides
 * *when* a message is set aside stays there.
 */
export interface SetAsideDeps {
	configDir: string;
	agentId: string;
	logger: PluginLogger;
	/** The dispatcher's dedupe set: a set-aside id is not probed again by the same session. */
	seen: Set<string>;
	/** Take the id out of `status=new` on the server; never throws. */
	acknowledge: (id: string) => Promise<void>;
}

export function makeSetAside(
	deps: SetAsideDeps,
): (msg: RineInbound, verdict: SetAsideReason) => Promise<boolean> {
	const { configDir, agentId, logger, seen, acknowledge } = deps;
	// The same discipline for the one install-level fault (`keyless.ts`).
	const announceKeyless = keylessAnnouncer({ logger, configDir, agentId });

	/**
	 * A message this agent could not open. 🔴 Always `true`: `false` means "dispatch
	 * failed, hold the cursor", and `transports/sse.ts` then freezes the resume point at
	 * the last contiguously-delivered id — so returning `false` here would PIN the stream
	 * on an unreadable message and replay from it on every restart. The precedent is the
	 * quarantine arm, which returns `true` for exactly this reason.
	 */
	return async function setAside(msg, verdict) {
		// `seen` is what keeps the poll transport, which re-fetches `status=new` every
		// interval, from re-probing and re-logging this row on every tick. The store's
		// own attempt bound is the real limiter; this only bounds the noise.
		seen.add(msg.id);
		if (verdict.kind === "refused") {
			// 🔴 Authenticity is PERMANENT — a forged signature or a sender mismatch is a
			// property of the bytes, so a retry can only ever return the same verdict and
			// re-presenting attacker-controlled bytes on a schedule is a log amplifier
			// whose cadence the attacker picks. Drained exactly as before, and recorded
			// only so "where did my message go" has a durable answer.
			logger.warn(
				`rine: refused message ${msg.id} from ${msg.fromHandle} (${verdict.verificationStatus}) — not dispatching, draining`,
			);
			recordSetAside(configDir, agentId, msg.id, verdict, logger);
			await acknowledge(msg.id);
			return true;
		}
		// 🔴 No key material at all is an INSTALL fault, not a message-shaped one:
		// it parks every inbound this agent will ever receive. Loud, and once per
		// agent — the per-message line below is INFO, which is what kept it silent.
		if (verdict.kind === "no-keys") announceKeyless();
		const rec = recordSetAside(configDir, agentId, msg.id, verdict, logger);
		// Once per entry, and then on every re-probe until the bound gives up: an
		// exhausted entry has already had its one loud line from the sweep, and
		// saying it again on every hourly re-probe is the storm the bound exists to
		// prevent. 🔴 A first sighting always speaks, even when the verdict arrived
		// already-exhausted because core calls it permanent — a message that will
		// never be retried is the one an operator most needs told about.
		if (rec.firstSighting || !rec.entry.exhausted) {
			const bounded = rec.entry.exhausted ? ", not retried" : "";
			logger.info(
				`rine: inbound ${msg.type} ${msg.id} from ${msg.fromHandle} is unreadable (${verdict.kind}) → set aside, left in the rine inbox${bounded}`,
			);
		}
		return true;
	};
}
