import type { MessageRead } from "@rine-network/core";
import type { AllowDecision, RineInbound } from "./types.js";

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
		type: str(u.type) ?? "a2a.artifact",
		isGroup: false,
		encryptedPayload: str(artifact.encrypted_payload) ?? "",
		encryptionVersion: str(artifact.encryption_version) ?? "cleartext",
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
