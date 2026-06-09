import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk";
import { normalizeA2A, normalizeStandardWebhook } from "../inbound.js";
import type { OnMessage } from "../dispatch.js";
import type { RineClient } from "../rine-client.js";
import type { TransportContext } from "./context.js";

export const RINE_INBOUND_PATH = "/rine/inbound";

/** Reject bodies larger than this before HMAC work — bounds memory + CPU on hostile input. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Live EXPOSE state, set when the EXPOSE transport starts and read by the HTTP route
 * handler (registered globally at `register()` time, no-op until EXPOSE is active).
 */
interface ExposeState {
	secret: string;
	onMessage: OnMessage;
	a2aAcceptCleartext: boolean;
	logger: PluginLogger;
}
let exposeState: ExposeState | undefined;

/** @internal Test-only reset. Stripped from shipped `.d.ts` (stripInternal). */
export function resetExposeStateForTest(): void {
	exposeState = undefined;
}

/** Read the request body with a hard size cap; undefined signals "too large". */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
		total += buf.length;
		if (total > MAX_BODY_BYTES) return undefined;
		chunks.push(buf);
	}
	return Buffer.concat(chunks);
}

/** The /rine/inbound handler: HMAC-verify, normalize (standard or A2A), dispatch. */
export async function handleInbound(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	if (req.method !== "POST") return false;
	const state = exposeState;
	if (!state) {
		res.statusCode = 503;
		res.end("rine expose inactive");
		return true;
	}
	const raw = await readBody(req);
	if (!raw) {
		res.statusCode = 413;
		res.end("payload too large");
		return true;
	}
	const sig = headerValue(req.headers["x-rine-signature"]);
	const { verifyRineSignature } = await import("./hmac.js");
	if (!verifyRineSignature(raw, sig, state.secret)) {
		state.logger.warn("rine: rejected inbound webhook with invalid HMAC signature");
		res.statusCode = 401;
		res.end("invalid signature");
		return true;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString("utf-8"));
	} catch {
		res.statusCode = 400;
		res.end("bad json");
		return true;
	}
	const inbound = normalizeA2A(parsed) ?? normalizeStandardWebhook(parsed);
	if (!inbound) {
		res.statusCode = 202;
		res.end("ignored");
		return true;
	}
	// Defense-in-depth: drop unencrypted A2A inbound unless explicitly opted in. The
	// canonical server-side card-policy PUT is a documented v0.2 item.
	if (inbound.encryptionVersion === "cleartext" && !state.a2aAcceptCleartext) {
		state.logger.warn(
			`rine: dropped cleartext inbound ${inbound.id} (a2aAcceptCleartext=false)`,
		);
		res.statusCode = 202;
		res.end("cleartext rejected");
		return true;
	}
	res.statusCode = 200;
	res.end("ok");
	await state.onMessage(inbound); // dispatch after ack (ingress already journaled by dedupe Set).
	return true;
}

function headerValue(h: string | string[] | undefined): string | undefined {
	return Array.isArray(h) ? h[0] : h;
}

/** Register the /rine/inbound route globally (idempotent no-op until EXPOSE active). */
export function registerExposeRoute(api: OpenClawPluginApi): void {
	api.registerHttpRoute({
		path: RINE_INBOUND_PATH,
		auth: "plugin",
		match: "exact",
		handler: handleInbound,
	});
}

interface CreatedWebhook {
	secret?: string;
	id?: string;
}

/**
 * EXPOSE transport. Requires a public base URL; enrolls a standard agent webhook
 * (`POST /webhooks`, HMAC-signed, fires on all inbound). On any precondition failure
 * (no URL / SSRF reject / enroll fail) it falls back to SSE. Never a hard failure.
 * The enrolled webhook is DELETEd best-effort on teardown so it doesn't accumulate
 * against the per-agent quota.
 */
export async function runExposeTransport(tc: TransportContext): Promise<void> {
	const { client, config, agentId, logger, onMessage } = tc;
	if (!config.exposeBaseUrl) {
		logger.warn(
			"rine: EXPOSE requires exposeBaseUrl (public Gateway URL) — falling back to SSE",
		);
		return fallbackToSse(tc);
	}
	const url = `${config.exposeBaseUrl.replace(/\/$/, "")}${RINE_INBOUND_PATH}`;
	let secret: string;
	let webhookId: string | undefined;
	try {
		const created = (await client.client.post("/webhooks", {
			agent_id: agentId,
			url,
		})) as CreatedWebhook;
		if (!created.secret) throw new Error("no secret returned");
		secret = created.secret;
		webhookId = created.id;
	} catch (err) {
		logger.warn(
			`rine: webhook enrollment failed (${err instanceof Error ? err.message : String(err)}) — falling back to SSE`,
		);
		return fallbackToSse(tc);
	}
	exposeState = {
		secret,
		onMessage,
		a2aAcceptCleartext: config.a2aAcceptCleartext,
		logger,
	};
	logger.info(`rine: EXPOSE active — standard webhook enrolled at ${url}`);
	try {
		// Keep the service alive until aborted; inbound arrives via the HTTP route.
		await waitUntilAbort(tc.signal);
	} finally {
		exposeState = undefined;
		await deleteWebhook(client, webhookId, logger);
	}
}

/** Best-effort webhook teardown; never throws (a failed delete must not crash stop). */
async function deleteWebhook(
	client: RineClient,
	webhookId: string | undefined,
	logger: PluginLogger,
): Promise<void> {
	if (!webhookId) return;
	try {
		await client.client.delete(`/webhooks/${webhookId}`);
	} catch (err) {
		logger.warn(
			`rine: webhook ${webhookId} cleanup failed (${err instanceof Error ? err.message : String(err)})`,
		);
	}
}

async function fallbackToSse(tc: TransportContext): Promise<void> {
	const { runSseTransport } = await import("./sse.js");
	await runSseTransport(tc);
}

function waitUntilAbort(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}
