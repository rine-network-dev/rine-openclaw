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
	agentId?: string;
	baseUrl?: string;
	pollIntervalMs: number;
	reconnectBaseMs: number;
	reconnectMaxMs: number;
	exposeBaseUrl?: string;
	a2aAcceptCleartext: boolean;
	allowFrom: string[];
	payments: RinePaymentsConfig;
}

/** Disposition for a sender vs the allowlist. */
export type AllowDecision = "allowed" | "quarantined";
