/** Normalized inbound rine message, transport-agnostic. */
export interface RineInbound {
	/** rine message id — the dedupe + mark-delivered key. */
	id: string;
	/** rine conversation uuid (thread id / A2A taskId). */
	conversationId: string;
	/**
	 * Sender handle `name@org`, or agent id when handle is absent.
	 *
	 * SECURITY: for A2A-sourced inbound this is the *self-reported* `from` field. The
	 * webhook HMAC authenticates the channel (the rine relay), NOT the asserted sender,
	 * so an A2A `fromHandle` is untrusted for authorization — gate on `allowFrom` only as
	 * a coarse filter, never as proof of identity.
	 */
	fromHandle: string;
	/** rine message type, e.g. `rine.v1.dm`. */
	type: string;
	/**
	 * `from_agent_id == to_agent_id` — a self-addressed message. A Funnel `rine.v1.webhook`
	 * is the canonical case (the relay sends on the agent's behalf), and the server rejects a
	 * reply to it ("Cannot reply to your own message"). Drives the one-way no-auto-reply guard.
	 * Absent when the transport can't determine both agent ids (e.g. A2A push).
	 */
	selfSend?: boolean;
	/** Whether this is a group/broadcast message. */
	isGroup: boolean;
	/** Group handle `#name@org` when `isGroup`. */
	groupHandle?: string;
	/** Raw ISO-8601 created timestamp. */
	createdAt?: string;
	/** Opaque ciphertext — decrypted on demand, never surfaced verbatim. */
	encryptedPayload: string;
	/** E2EE scheme tag, e.g. `hpke-v1`, `mls-v1`. */
	encryptionVersion: string;
	/** Group id (uuid) for group decrypt. */
	groupId?: string;
	/**
	 * The sender agent id the SERVER authenticated on this row, when it carried one.
	 *
	 * Distinct from `fromHandle` and not interchangeable with it: the handle is a
	 * display/allowlist string and, on the A2A path, self-reported by the producer.
	 * This is what the runtime's readability probe checks the envelope's own claim of
	 * authorship against — so an envelope arriving without it is never opened on
	 * trust, it is reported as `not-ciphertext` and dispatched exactly as it is today.
	 * Absent when the transport can't determine it (A2A push).
	 */
	fromAgentId?: string;
}

/**
 * x402 payment posture. Opt-in, default OFF: with `autoPay` false the exposed
 * `rine_pay` tool keeps its shipped explicit-authorization semantics (each call is the
 * authorization, bounded by the wallet spend caps). With `autoPay` true the tool defaults
 * to threshold-gated auto-pay — it pays a quote only at/below the wallet policy's
 * `autoPayThreshold` and returns `above-auto-pay-threshold` otherwise. The threshold, caps,
 * deny-by-default policy, journal and reserve-lock all live in the wallet spend policy
 * (`rine wallet policy`, enforced in rine-core); this flag only flips the tool-call default,
 * it never widens a cap and never touches dispatch.
 */
export interface RinePaymentsConfig {
	autoPay: boolean;
}

/** Resolved plugin config (after defaults). Mirrors `openclaw.plugin.json` configSchema. */
export interface RineConfig {
	transport: "expose" | "sse" | "poll";
	configDir?: string;
	/**
	 * The agent this install acts as, exactly as the operator wrote it — a bare name, a
	 * handle or a UUID, never resolved here. Its two consumers are not the same notion:
	 * `resolveBoundAgentId` turns it into the UUID the notify service binds its inbox to,
	 * while `withActingAgent` threads the raw string onto every tool call as that call's
	 * acting-agent default and lets rine-mcp resolve it per call. Unset means "the org's
	 * only agent" on both paths, and nothing at all on an org that has several.
	 */
	agentId?: string;
	baseUrl?: string;
	pollIntervalMs: number;
	reconnectBaseMs: number;
	reconnectMaxMs: number;
	/**
	 * How often the bounded set-aside retry sweeps, in milliseconds.
	 *
	 * The counterpart of `hermes_rine`'s `RINE_SETASIDE_SWEEP_INTERVAL`, and the
	 * only one of the four set-aside bounds an operator can move: the attempt,
	 * batch and capacity limits are compile-time constants on both surfaces
	 * because they bound work per sweep, while this bounds how often a sweep
	 * happens at all — which is what an operator chasing one stuck message, or
	 * quietening a busy gateway, actually needs.
	 *
	 * Configuration rather than an environment variable because that is how this
	 * surface is configured; the two reach the same knob by each host's own idiom.
	 */
	setasideSweepIntervalMs: number;
	exposeBaseUrl?: string;
	a2aAcceptCleartext: boolean;
	allowFrom: string[];
	payments: RinePaymentsConfig;
}

/** Disposition for a sender vs the allowlist. */
export type AllowDecision = "allowed" | "quarantined";
