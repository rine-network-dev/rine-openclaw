import { probeReadability } from "@rine-network/core";
import type { DispatchOpts, OnMessage, OnMessageDeps } from "./dispatch-words.js";
import { msgOf } from "./err.js";
import { isAllowed, readabilityArgsFor } from "./inbound.js";
import { keylessAnnouncer } from "./keyless.js";
import { isDispatchable, recordSetAside } from "./setaside.js";
import type { SetAsideReason } from "./setaside.js";
import { startSweepSchedule } from "./setaside-schedule.js";
import type { RineInbound } from "./types.js";

export * from "./dispatch-words.js";

/**
 * Build the shared `onMessage` path all transports converge on.
 *
 * Invariants:
 *  - dedupe by rine message id (Set, add-id-BEFORE-await race guard; delete-on-error
 *    so a failed dispatch is retried; hourly clear bounds memory).
 *  - the RUNTIME decides readability before the harness is woken, and a message this
 *    agent's keys cannot open is set aside instead of being dispatched-and-consumed.
 *    This is a deliberate policy: the runtime decides to defer a read, the model
 *    never asks it to.
 *  - mark-delivered ONLY after a successful dispatch (at-least-once), or on a permanent
 *    authenticity refusal (drained, as before).
 *  - disallowed sender → quarantine (logged exactly once), no dispatch, not marked
 *    delivered (recoverable after the operator fixes allowFrom + restarts the gateway),
 *    and asked again on the retry path so a narrowed `allowFrom` is honoured.
 *  - the bounded retry of what was set aside runs on a schedule this function starts
 *    (`setaside-schedule.ts`) and asks for again after each delivered turn — never in
 *    front of one.
 *
 * 🔴 It starts a TIMER, bounded by `deps.signal`. A caller that builds an `onMessage`
 * per connection attempt gets a retry schedule per connection attempt, which is why
 * `service.ts` builds one per notify loop and aborts the signal when the channel stops.
 */
export function makeOnMessage(deps: OnMessageDeps): OnMessage {
	const { client, config, agentId, logger, dispatch, signal } = deps;
	const seen = new Set<string>();
	// Quarantined ids are NOT subject to the hourly seen.clear() — log exactly once.
	const quarantined = new Set<string>();
	// The same discipline for the one install-level fault (`keyless.ts`).
	const announceKeyless = keylessAnnouncer({
		logger,
		configDir: client.configDir,
		agentId,
	});
	let lastClear = Date.now();

	function maybeClear(): void {
		if (Date.now() - lastClear > 3_600_000) {
			seen.clear();
			lastClear = Date.now();
		}
	}

	/**
	 * Is this sender disallowed? Logged exactly once per message id, here rather
	 * than at either caller, because there are two: the live path asks before it
	 * spends any crypto, and {@link deliver} asks again for the retry sweep, whose
	 * entries were set aside under whatever `allowFrom` was in force at the time.
	 *
	 * 🔴 An `allowFrom` narrowed between the two would otherwise dispatch a
	 * message the operator has since excluded — the store outlives the process and
	 * the config, so "it passed the gate once" is not an answer to "does it pass
	 * now".
	 */
	function quarantine(msg: RineInbound): boolean {
		if (isAllowed(msg.fromHandle, config.allowFrom) === "allowed") return false;
		if (!quarantined.has(msg.id)) {
			quarantined.add(msg.id);
			logger.warn(
				`rine: quarantined message ${msg.id} from disallowed sender "${msg.fromHandle}" (allowFrom=${config.allowFrom.join(",")}; allowFrom changes take effect on gateway restart)`,
			);
		}
		return true;
	}

	async function markSafely(id: string): Promise<void> {
		try {
			await client.markDelivered(agentId, [id]);
		} catch (err) {
			logger.warn(`rine: mark-delivered failed for ${id} (already dispatched): ${msgOf(err)}`);
		}
	}

	/**
	 * The delivery path: the one place an inbound becomes an agent turn, reached both by a
	 * fresh message and by one the retry sweep opened. Its INFO line is one per delivered
	 * inbound — deduped replays, quarantined senders and set-aside messages never get here.
	 *
	 * 🔴 `true` for a quarantined sender, matching the live path's arm: the turn is
	 * terminally not happening, the row is NOT acked (still there for `rine_inbox`
	 * / `rine_read`), and the sweep must not count it as a failed delivery and
	 * retry it on a schedule the operator has already excluded.
	 */
	async function deliver(msg: RineInbound, opts?: DispatchOpts): Promise<boolean> {
		if (quarantine(msg)) return true;
		logger.info(`rine: inbound ${msg.type} ${msg.id} from ${msg.fromHandle} → dispatching`);
		seen.add(msg.id); // BEFORE await — race guard against concurrent delivery.
		try {
			await dispatch(msg, signal, opts);
		} catch (err) {
			seen.delete(msg.id); // re-eligible on next delivery.
			logger.error(`rine: dispatch failed for ${msg.id}: ${msgOf(err)}`);
			return false; // do NOT mark delivered or advance the cursor — retried on next delivery.
		}
		await markSafely(msg.id);
		return true;
	}

	/**
	 * A message this agent could not open. 🔴 Always `true`: `false` means "dispatch
	 * failed, hold the cursor", and `transports/sse.ts` then freezes the resume point at
	 * the last contiguously-delivered id — so returning `false` here would PIN the stream
	 * on an unreadable message and replay from it on every restart. The precedent is the
	 * quarantine arm, which returns `true` for exactly this reason.
	 */
	async function setAside(msg: RineInbound, verdict: SetAsideReason): Promise<boolean> {
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
			recordSetAside(client.configDir, agentId, msg.id, verdict, logger);
			await markSafely(msg.id);
			return true;
		}
		// 🔴 No key material at all is an INSTALL fault, not a message-shaped one:
		// it parks every inbound this agent will ever receive. Loud, and once per
		// agent — the per-message line below is INFO, which is what kept it silent.
		if (verdict.kind === "no-keys") announceKeyless();
		const rec = recordSetAside(client.configDir, agentId, msg.id, verdict, logger);
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
	}

	const sweep = startSweepSchedule({
		client: client.client,
		configDir: client.configDir,
		agentId,
		logger,
		deliver,
		signal,
		intervalMs: config.setasideSweepIntervalMs,
	});

	return async function onMessage(msg: RineInbound, opts?: DispatchOpts): Promise<boolean> {
		maybeClear();
		if (seen.has(msg.id)) return true; // already handled this session — not a gap.

		if (quarantine(msg)) {
			// Terminally filtered (logged once; still server-retrievable via the tools). Advance
			// the cursor past it so a disallowed sender can't pin/replay the stream every restart.
			return true;
		}

		// 🔴 After the dedupe and the allowlist, so a replay or a quarantined sender costs
		// no crypto — and BEFORE the harness is woken, which is the whole point: the
		// runtime decides readability, the model never chooses. The probe's `opened` arm
		// carries no plaintext by type, so nothing here can reach a transcript.
		const verdict = await probeReadability(
			readabilityArgsFor(msg, {
				client: client.client,
				configDir: client.configDir,
				agentId,
			}),
		);
		if (!isDispatchable(verdict)) return setAside(msg, verdict);
		const handled = await deliver(msg, opts);
		// 🔴 AFTER the turn, never in front of it. A sweep at the head of this
		// function made every inbound message wait behind up to a full list of
		// re-reads and decrypt attempts; here it costs the message nothing, and it
		// runs at the one moment the list is most likely to open — the probe above
		// has just taken delivery of whatever sender key this message carried.
		// Awaited rather than fired and forgotten so a healed message's turn is not
		// dispatched concurrently with the live one that healed it.
		await sweep();
		return handled;
	};
}
