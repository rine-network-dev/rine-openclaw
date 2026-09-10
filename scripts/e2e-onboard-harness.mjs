#!/usr/bin/env node
/**
 * Container-side tool-invocation harness for the from-scratch onboarding E2E.
 *
 * It loads the plugin exactly as the gateway does — the BUILT `dist/index.js`, driven
 * through the real `defineChannelPluginEntry` `register()` in "full" registration mode,
 * reading the real `openclaw.json` (`OPENCLAW_CONFIG_PATH`) so `channels.rine` is the
 * documented, authoritative config block — then invokes ONE registered tool the way an
 * agent turn does (`tool.execute(callId, params, signal)`). The block configures the
 * channel; it does not activate the plugin (`activation.onStartup` does).
 *
 * Why a harness and not an LLM turn through `openclaw agent`: the gateway only emits a
 * tool call when a model decides to. That needs a provider key and is non-deterministic,
 * which is untestable as a gate. Everything below the tool call — plugin load, config
 * resolution, credential resolution, HTTP client construction, the mcp tool handler —
 * is the identical production code path; only the caller of `execute` differs.
 *
 * Usage:
 *   node scripts/e2e-onboard-harness.mjs --list [--probe-service]
 *   node scripts/e2e-onboard-harness.mjs <tool_name> '<json-params>'
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist/index.js", import.meta.url).href;

/**
 * Manifest-declared optional tools. OpenClaw gates a plugin tool when EITHER the
 * registerTool call or this manifest block marks it optional, so the E2E asserts both.
 */
function manifestOptionalTools() {
	const manifest = JSON.parse(
		readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
	);
	return Object.entries(manifest.toolMetadata ?? {})
		.filter(([, v]) => v?.optional)
		.map(([k]) => k);
}

function readOpenClawConfig() {
	const p = process.env.OPENCLAW_CONFIG_PATH;
	if (!p || !existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, "utf-8"));
	} catch (err) {
		throw new Error(`cannot parse OPENCLAW_CONFIG_PATH=${p}: ${err.message}`);
	}
}

/** Spy OpenClawPluginApi: captures every registration the plugin performs. */
function makeSpyApi(config) {
	const logs = [];
	const rec = (level) => (msg) => logs.push(`${level}: ${msg}`);
	const tools = new Map();
	const services = [];
	const channels = [];
	const routes = [];
	const api = {
		id: "rine",
		name: "rine",
		registrationMode: "full",
		pluginConfig: {},
		config,
		runtime: { channel: {} },
		logger: { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") },
		registerChannel: (r) => channels.push(r?.plugin?.id ?? r?.id ?? "channel"),
		registerTool: (t, opts) => tools.set(t.name, { tool: t, opts }),
		registerService: (s) => services.push(s),
		registerHttpRoute: (r) => routes.push(r?.path ?? "route"),
	};
	return { api, logs, tools, services, channels, routes };
}

async function loadEntry() {
	const mod = await import(DIST);
	const entry = mod.default ?? mod;
	const register = entry.register ?? entry.default?.register;
	if (typeof register !== "function") {
		throw new Error("plugin dist has no register() — build dist first (npm run build)");
	}
	return register;
}

function credentialState() {
	const dir = process.env.RINE_CONFIG_DIR ?? "";
	const credPath = dir ? join(dir, "credentials.json") : "";
	const present = Boolean(credPath) && existsSync(credPath);
	let handleInfo = null;
	if (present) {
		try {
			const creds = JSON.parse(readFileSync(credPath, "utf-8"));
			const d = creds.default ?? {};
			handleInfo = {
				client_id: d.client_id ? `${String(d.client_id).slice(0, 8)}…` : null,
				has_client_secret: Boolean(d.client_secret),
				has_poll_url: Boolean(d.poll_url),
			};
		} catch {
			handleInfo = { parse_error: true };
		}
	}
	return { configDir: dir, credentialsPresent: present, credentials: handleInfo };
}

/** Extract the structured payload from an OpenClaw tool result (jsonResult → details/content). */
function unwrapResult(result) {
	if (result && typeof result === "object") {
		if (result.details !== undefined) return result.details;
		const text = result.content?.[0]?.text;
		if (typeof text === "string") {
			try {
				return JSON.parse(text);
			} catch {
				return { text };
			}
		}
	}
	return result;
}

async function main() {
	const [modeArg, paramsArg] = process.argv.slice(2);
	if (!modeArg) {
		console.error("usage: e2e-onboard-harness.mjs --list [--probe-service] | <tool> '<json>'");
		process.exit(2);
	}

	const config = readOpenClawConfig();
	const { api, logs, tools, services, channels, routes } = makeSpyApi(config);
	const register = await loadEntry();

	// The load-without-credentials assertion: registerFull must not throw pre-onboarding.
	let registerError = null;
	try {
		register(api);
	} catch (err) {
		registerError = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
	}

	if (modeArg === "--list") {
		if (process.argv.includes("--probe-service") && !registerError) {
			// Start/stop the notify service to capture the pre-onboarding service UX.
			for (const svc of services) {
				try {
					svc.start({ logger: api.logger });
					await new Promise((r) => setTimeout(r, 750));
					svc.stop?.();
				} catch (err) {
					logs.push(`service-start-threw: ${err.message}`);
				}
			}
		}
		console.log(
			JSON.stringify(
				{
					registerError,
					channels,
					tools: [...tools.keys()],
					optionalTools: [...tools.entries()]
						.filter(([, v]) => v.opts?.optional)
						.map(([k]) => k),
					manifestOptionalTools: manifestOptionalTools(),
					services: services.map((s) => s.id),
					httpRoutes: routes,
					channelConfig: config?.channels?.rine ?? null,
					apiUrl: process.env.RINE_API_URL ?? null,
					...credentialState(),
					logs,
				},
				null,
				2,
			),
		);
		process.exit(registerError ? 1 : 0);
	}

	if (registerError) {
		console.error(`REGISTER_FAILED: ${registerError}`);
		process.exit(1);
	}

	const entry = tools.get(modeArg);
	if (!entry) {
		console.error(`TOOL_NOT_REGISTERED: ${modeArg} (have: ${[...tools.keys()].join(", ")})`);
		process.exit(1);
	}
	const params = paramsArg ? JSON.parse(paramsArg) : {};
	const started = Date.now();
	const raw = await entry.tool.execute(`e2e-${Date.now()}`, params, undefined);
	const payload = unwrapResult(raw);
	console.error(`[harness] ${modeArg} took ${((Date.now() - started) / 1000).toFixed(1)}s`);
	for (const line of logs) console.error(`[plugin] ${line}`);
	console.log(`RESULT_JSON:${JSON.stringify(payload)}`);
	// A tool that failed returns {error: "rine: <tool> failed: …"} (toOpenClawTool catches).
	process.exit(payload && typeof payload === "object" && payload.error ? 1 : 0);
}

main().catch((err) => {
	console.error(`HARNESS_ERROR: ${err?.stack ?? err}`);
	process.exit(1);
});
