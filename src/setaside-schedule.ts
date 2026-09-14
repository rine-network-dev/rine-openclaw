import { SETASIDE_SWEEP_INTERVAL_MS } from "./constants.js";
import { msgOf } from "./err.js";
import { sweepSetAside } from "./setaside-sweep.js";
import type { SweepArgs } from "./setaside-sweep.js";

/**
 * WHEN the bounded retry runs — both an automatic sweep and an on-demand one.
 * What it does when it runs is `setaside-sweep.ts`; what it reads and writes is
 * `setaside.ts`.
 *
 * Two triggers, one gate:
 *
 *  - a TIMER, so a quiet channel still retries. This is the half openclaw shipped
 *    without: the sweep hung off the head of `onMessage`, so a gateway that
 *    received nothing for six hours retried nothing for six hours — and the
 *    entries most likely to heal are exactly the ones a since-restarted peer has
 *    since sent a key for. `hermes_rine` runs its equivalent on the poll tick,
 *    which never stops; a connector driven by a push transport has no tick of its
 *    own, so it needs this one.
 *  - the TAIL of each handled inbound, because the thing that heals a `sealed`
 *    entry is a `rine.v1.sender_key_distribution` DM whose key
 *    `probeReadability` has just taken delivery of. Sweeping then is the one
 *    moment the list is most likely to open, and it costs no wall-clock the
 *    message was waiting on: it runs after the turn is dispatched, never in front
 *    of it.
 *
 * 🔴 One gate for both, so they can never run back to back or on top of each
 * other: `lastSweep` bounds the cadence and `sweeping` bounds the overlap. A
 * busy stream therefore sweeps on the interval and not on every frame, and the
 * timer finds the work already done.
 *
 * 🔴 What is NOT serialised, stated rather than discovered: the timer can
 * dispatch a healed message while a live one is in flight. The dedupe Set in
 * `dispatch.ts` adds an id BEFORE its await, so the same message cannot be
 * dispatched twice; the order of two DIFFERENT messages is not guaranteed, which
 * was already true of a connector that accepts push and poll.
 */

/** Everything the sweep needs, plus the lifetime that bounds the timer. */
export interface ScheduleArgs extends SweepArgs {
	/**
	 * The transport's own signal. The timer is cleared when it aborts, which is
	 * what keeps a stopped channel from holding the event loop or reading a config
	 * dir the gateway has moved on from.
	 */
	signal: AbortSignal;
	/**
	 * Milliseconds between automatic sweeps — `channels.rine`'s
	 * `setasideSweepIntervalMs`, defaulted and floored by `config.ts`.
	 *
	 * Read ONCE here, at channel start, which is the honest semantics for a
	 * config-file knob: `channels.rine` is loaded when the gateway starts the
	 * channel, so re-reading it per tick would poll a value that cannot change
	 * without a restart anyway. `hermes_rine` reads its environment variable per
	 * tick because an environment variable *can* change under a running process.
	 * Same knob, same default, each surface's own idiom.
	 */
	intervalMs?: number;
}

/**
 * Start the interval and hand back the gated sweep the interval itself runs.
 *
 * Returns a function rather than an object: there is one thing to ask for, it
 * never throws, and a caller that awaits it is awaiting the same single-flight
 * sweep the timer would have run.
 */
export function startSweepSchedule(a: ScheduleArgs): () => Promise<void> {
	// Zero, not Date.now(): the first inbound after a restart should retry
	// whatever the previous process set aside, rather than wait out an interval it
	// never served.
	let lastSweep = 0;
	let sweeping = false;
	// The floor is here as well as in `config.ts` because this function is also
	// reached without one: `intervalMs` is optional, and a caller that builds
	// `ScheduleArgs` by hand — every test in this package does — never passes
	// through `resolveRineConfig`. A zero here is a spinning timer.
	const intervalMs =
		a.intervalMs !== undefined && a.intervalMs > 0
			? a.intervalMs
			: SETASIDE_SWEEP_INTERVAL_MS;

	async function sweep(): Promise<void> {
		if (sweeping || Date.now() - lastSweep < intervalMs) return;
		lastSweep = Date.now();
		sweeping = true;
		try {
			await sweepSetAside(a);
		} catch (err) {
			// Belt to the sweep's own braces: a retry must never cost the live
			// message that triggered it, and must never take down the timer.
			a.logger.warn(`rine: set-aside sweep failed: ${msgOf(err)}`);
		} finally {
			sweeping = false;
		}
	}

	if (!a.signal.aborted) {
		const timer = setInterval(() => void sweep(), intervalMs);
		// Unref'd so the retry schedule can never be the reason a Node process
		// declines to exit; the abort listener is what actually stops it.
		timer.unref?.();
		a.signal.addEventListener("abort", () => clearInterval(timer), {
			once: true,
		});
	}
	return sweep;
}
