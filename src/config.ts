import {
	getCredentialEntry,
	resolveApiUrl,
	resolveConfigDir,
} from "@rine-network/core";
import type { CredentialEntry } from "@rine-network/core";
import {
	CHANNEL_ID,
	DEFAULT_ACCOUNT_ID,
	SETASIDE_SWEEP_INTERVAL_MS,
} from "./constants.js";
import type { RineConfig, RinePaymentsConfig } from "./types.js";

const DEFAULTS = {
	transport: "sse",
	pollIntervalMs: 60_000,
	reconnectBaseMs: 3_000,
	reconnectMaxMs: 300_000,
	// Imported, never retyped: the sweep's own module owns this number and the
	// comment explaining it, and `hermes_rine._setaside` is pinned against it.
	setasideSweepIntervalMs: SETASIDE_SWEEP_INTERVAL_MS,
	a2aAcceptCleartext: true,
} as const;

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function asNumber(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * A number that has to be positive to mean anything.
 *
 * 🔴 Separate from {@link asNumber} because zero and negatives are *valid
 * finite numbers* and would be taken: a sweep interval of `0` turns the retry
 * timer into a spin, and a negative one makes every tick due forever. The
 * manifest declares `minimum` so the host refuses it first, but this function is
 * the floor for the paths the manifest does not cover — a config record handed
 * in directly, and every call in this package's own tests. `hermes_rine`'s
 * `sweep_interval_seconds` falls back for the same reason and says the same
 * thing: a silently disabled retry reads exactly like the behaviour it replaced.
 */
function asPositiveNumber(v: unknown, fallback: number): number {
	const n = asNumber(v, fallback);
	return n > 0 ? n : fallback;
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

/** Opt-in payments posture: auto-pay defaults OFF. */
function asPayments(v: unknown): RinePaymentsConfig {
	return { autoPay: asRecord(v).autoPay === true };
}

/** Resolve the typed config from a raw config record (or `{}`), applying defaults. */
export function resolveRineConfig(raw: Record<string, unknown> = {}): RineConfig {
	return {
		transport: asTransport(raw.transport),
		payments: asPayments(raw.payments),
		configDir: asString(raw.configDir),
		agentId: asString(raw.agentId),
		baseUrl: asString(raw.baseUrl),
		pollIntervalMs: asNumber(raw.pollIntervalMs, DEFAULTS.pollIntervalMs),
		reconnectBaseMs: asNumber(raw.reconnectBaseMs, DEFAULTS.reconnectBaseMs),
		reconnectMaxMs: asNumber(raw.reconnectMaxMs, DEFAULTS.reconnectMaxMs),
		setasideSweepIntervalMs: asPositiveNumber(
			raw.setasideSweepIntervalMs,
			DEFAULTS.setasideSweepIntervalMs,
		),
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
 * `channels.rine` is the documented, AUTHORITATIVE home for `transport`/`allowFrom`/etc. It is
 * not what ACTIVATES the plugin — `activation.onStartup` in the manifest is. The older wording
 * here called the block "activation-required", which named the wrong mechanism; what happens
 * to an enabled plugin whose config omits the block is a HOST question, answered on the
 * integration page, not a property of this resolver. This function answers it for its own
 * layer only: every field defaults, so an absent block resolves to a complete RineConfig.
 * `plugins.entries.rine.config` is merged underneath as a fallback for installs
 * that placed config there (both are validated against the same manifest schema). This
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
