import {
	getCredentialEntry,
	resolveApiUrl,
	resolveConfigDir,
} from "@rine-network/core";
import type { CredentialEntry } from "@rine-network/core";
import { DEFAULT_ACCOUNT_ID } from "./constants.js";
import type { RineConfig } from "./types.js";

const DEFAULTS = {
	transport: "sse",
	pollIntervalMs: 60_000,
	reconnectBaseMs: 3_000,
	reconnectMaxMs: 300_000,
	a2aAcceptCleartext: true,
} as const;

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function asNumber(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asTransport(v: unknown): RineConfig["transport"] {
	return v === "expose" || v === "poll" || v === "sse" ? v : DEFAULTS.transport;
}

function asAllowFrom(v: unknown): string[] {
	if (Array.isArray(v)) {
		const entries = v.filter((e): e is string => typeof e === "string");
		return entries.length > 0 ? entries : ["*"];
	}
	return ["*"];
}

/** Resolve the typed config from a raw `api.pluginConfig` (or `{}`), applying defaults. */
export function resolveRineConfig(raw: Record<string, unknown> = {}): RineConfig {
	return {
		transport: asTransport(raw.transport),
		configDir: asString(raw.configDir),
		agentId: asString(raw.agentId),
		baseUrl: asString(raw.baseUrl),
		pollIntervalMs: asNumber(raw.pollIntervalMs, DEFAULTS.pollIntervalMs),
		reconnectBaseMs: asNumber(raw.reconnectBaseMs, DEFAULTS.reconnectBaseMs),
		reconnectMaxMs: asNumber(raw.reconnectMaxMs, DEFAULTS.reconnectMaxMs),
		exposeBaseUrl: asString(raw.exposeBaseUrl),
		a2aAcceptCleartext:
			typeof raw.a2aAcceptCleartext === "boolean"
				? raw.a2aAcceptCleartext
				: DEFAULTS.a2aAcceptCleartext,
		allowFrom: asAllowFrom(raw.allowFrom),
	};
}

export interface ResolvedCreds {
	configDir: string;
	apiUrl: string;
	entry: CredentialEntry | undefined;
	pollUrl: string | undefined;
}

/**
 * Resolve rine credentials using core's 3-level config-dir fallback
 * ($RINE_CONFIG_DIR > ~/.config/rine > $PWD/.rine). An explicit `cfg.configDir`
 * override wins and is threaded directly — we never mutate `process.env`. Reuses core
 * helpers; no host keychain access, no token writes.
 */
export function readRineCredentials(cfg: RineConfig): ResolvedCreds {
	const configDir = cfg.configDir ?? resolveConfigDir();
	const apiUrl = cfg.baseUrl ?? resolveApiUrl();
	const entry = getCredentialEntry(configDir, DEFAULT_ACCOUNT_ID);
	return { configDir, apiUrl, entry, pollUrl: entry?.poll_url };
}
