import {
	A2A_MESSAGE_TYPE,
	CLEARTEXT_ENCRYPTION_VERSION,
	type HttpClient,
	type MessageRead,
	type OpenInboundArgs,
} from "@rine-network/core";
import type { AllowDecision, RineInbound } from "./types.js";

/**
 * The wire fields of an inbound message that say whether it is A2A cleartext, in the
 * shape core's `isA2aCleartext` and `withA2aCleartextNotice` read.
 */
export function wireRowOf(msg: Pick<RineInbound, "type" | "encryptionVersion">) {
	return { type: msg.type, encryption_version: msg.encryptionVersion };
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Normalize a rine SSE `event: message` payload (or a `/messages` item) — both are
 * a full `MessageRead` JSON — into the transport-agnostic `RineInbound`.
 */
export function normalizeRineEvent(raw: MessageRead): RineInbound {
	const groupHandle = str(raw.group_handle);
	const groupId = str(raw.group_id);
	const isGroup = Boolean(groupHandle ?? groupId);
	const fromAgentId = str(raw.from_agent_id);
	const toAgentId = str(raw.to_agent_id);
	return {
		id: raw.id,
		conversationId: raw.conversation_id,
		fromHandle: str(raw.sender_handle) ?? str(raw.from_agent_id) ?? "unknown",
		type: raw.type,
		selfSend: Boolean(fromAgentId && fromAgentId === toAgentId),
		isGroup,
		groupHandle,
		groupId,
		createdAt: raw.created_at,
		encryptedPayload: raw.encrypted_payload,
		encryptionVersion: raw.encryption_version,
		fromAgentId,
	};
}

/**
 * What `probeReadability`/`openInbound` need to decide one inbound envelope.
 *
 * Here rather than at either call site because there are two of them — the
 * dispatch gate and the set-aside retry sweep — and this file is where a
 * `RineInbound` is already made out of a server row. A field renamed on one side
 * and not the other would show up as a message that quietly stops opening.
 *
 * 🔴 `fromAgentId` and `groupId` go through as `null` when absent, never as
 * `undefined`: core's pre-gate refuses a null sender with `not-ciphertext`,
 * which is the arm that keeps an A2A artifact (no authenticated sender,
 * `encryption_version: "none"`) dispatching exactly as it does today.
 *
 * 🔴 `createdAt` goes through at every site: core's decrypt checks the sender's key
 * against the key generation that was current when the server stamped the message, so a
 * decrypt without it would judge an old message by a rotated key.
 */
export function readabilityArgsFor(
	msg: RineInbound,
	ctx: { client: HttpClient; configDir: string; agentId: string },
): OpenInboundArgs {
	return {
		client: ctx.client,
		configDir: ctx.configDir,
		agentId: ctx.agentId,
		fromAgentId: msg.fromAgentId ?? null,
		groupId: msg.groupId ?? null,
		messageType: msg.type,
		encryptedPayload: msg.encryptedPayload,
		encryptionVersion: msg.encryptionVersion,
		createdAt: msg.createdAt,
	};
}

/**
 * Normalize a rine standard-webhook body. rine's webhook delivers the message
 * record (possibly wrapped under `message`/`data`). Falls through to the same
 * MessageRead shape as the SSE/messages path.
 */
export function normalizeStandardWebhook(body: unknown): RineInbound | undefined {
	if (!body || typeof body !== "object") return undefined;
	const obj = body as Record<string, unknown>;
	const inner =
		(obj.message as MessageRead | undefined) ??
		(obj.data as MessageRead | undefined) ??
		(obj as unknown as MessageRead);
	if (!inner || typeof inner !== "object" || typeof inner.id !== "string") {
		return undefined;
	}
	return normalizeRineEvent(inner);
}

/**
 * Normalize an A2A per-task push (`result.artifactUpdate` JSON-RPC envelope).
 * taskId == contextId == conversationId. Returns undefined if the shape doesn't match.
 *
 * SECURITY: `from` (→ `fromHandle`) is self-reported by the A2A producer. The webhook
 * HMAC proves the *channel* (the rine relay) is genuine, not that the asserted sender is
 * who they claim — treat the handle as unverified for any trust decision.
 */
export function normalizeA2A(body: unknown): RineInbound | undefined {
	if (!body || typeof body !== "object") return undefined;
	const result = (body as Record<string, unknown>).result;
	if (!result || typeof result !== "object") return undefined;
	const upd = (result as Record<string, unknown>).artifactUpdate;
	if (!upd || typeof upd !== "object") return undefined;
	const u = upd as Record<string, unknown>;
	const taskId = str(u.taskId) ?? str(u.contextId);
	if (!taskId) return undefined;
	const artifact = (u.artifact as Record<string, unknown> | undefined) ?? {};
	return {
		id: str(u.artifactId) ?? str(artifact.artifactId) ?? taskId,
		conversationId: taskId,
		fromHandle: str(u.from) ?? "a2a",
		type: str(u.type) ?? A2A_MESSAGE_TYPE,
		isGroup: false,
		encryptedPayload: str(artifact.encrypted_payload) ?? "",
		encryptionVersion:
			str(artifact.encryption_version) ?? CLEARTEXT_ENCRYPTION_VERSION,
	};
}

/** Normalize the org component of a `name@org` / `#name@org` handle. */
function orgOf(handle: string): string | undefined {
	const at = handle.lastIndexOf("@");
	return at >= 0 ? handle.slice(at + 1) : undefined;
}

/**
 * Allowlist decision. `*` = allow all; `@org` = org-scoped; exact handle match.
 * Disallowed senders are **quarantined** (caller logs), never silently dropped.
 */
export function isAllowed(fromHandle: string, allowFrom: string[]): AllowDecision {
	if (allowFrom.length === 0 || allowFrom.includes("*")) return "allowed";
	const org = orgOf(fromHandle);
	for (const entry of allowFrom) {
		if (entry === fromHandle) return "allowed";
		if (entry.startsWith("@") && org && entry.slice(1) === org) return "allowed";
	}
	return "quarantined";
}
