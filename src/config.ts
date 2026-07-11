import {
	getCredentialEntry,
	resolveApiUrl,
	resolveConfigDir,
} from "@rine-network/core";
import type { CredentialEntry } from "@rine-network/core";
import { CHANNEL_ID, DEFAULT_ACCOUNT_ID } from "./constants.js";
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

/** Resolve the typed config from a raw config record (or `{}`), applying defaults. */
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

function asRecord(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

/**
 * Resolve the typed config from a live OpenClawConfig (`api.config` / an outbound `ctx.cfg`).
 *
 * `channels.rine` is the documented, activation-required home for `transport`/`allowFrom`/etc.,
 * so it is authoritative; `plugins.entries.rine.config` is merged underneath as a fallback for
 * installs that placed config there (both are validated against the same manifest schema). This
 * is the single source of truth for the notify service, the tool client, and the outbound
 * adapter — before, the service/tools read `api.pluginConfig` (`plugins.entries.rine.config`)
 * while outbound read `channels.rine`, so `channels.rine.transport` was silently ignored.
 */
export function resolveRineConfigFromCfg(cfg: unknown): RineConfig {
	const root = asRecord(cfg);
	const channelCfg = asRecord(asRecord(root.channels)[CHANNEL_ID]);
	const entryCfg = asRecord(asRecord(asRecord(root.plugins).entries)[CHANNEL_ID]).config;
	return resolveRineConfig({ ...asRecord(entryCfg), ...channelCfg });
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
