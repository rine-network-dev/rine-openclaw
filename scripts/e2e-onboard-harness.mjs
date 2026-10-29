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
 * resolution, identity resolution, HTTP client construction, the mcp tool handler —
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
	const hooks = [];
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
		on: (hookName) => hooks.push(hookName),
	};
	return { api, logs, tools, services, channels, routes, hooks };
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

/**
 * What identity files exist, as presence flags only: no key, id or phrase byte is read, so
 * nothing here can leak into a log. The org root and the phrase file sit in the owner dir
 * (`RINE_OWNER_DIR`); the agent's `profiles.json` sits in the runtime dir (`RINE_CONFIG_DIR`).
 */
function identityState() {
	const profilesFile = "profiles.json";
	const configDir = process.env.RINE_CONFIG_DIR ?? "";
	const ownerDir = process.env.RINE_OWNER_DIR ?? "";
	const has = (dir, name) => Boolean(dir) && existsSync(join(dir, name));
	let hasPollUrl = false;
	if (has(configDir, profilesFile)) {
		try {
			const profiles = JSON.parse(readFileSync(join(configDir, profilesFile), "utf-8"));
			hasPollUrl = Object.values(profiles).some((p) => Boolean(p?.poll_url));
		} catch {
			hasPollUrl = false;
		}
	}
	const identity = {
		has_root_key: has(ownerDir, "root.key"),
		has_phrase_file: has(ownerDir, "recovery-phrase.txt"),
		has_profiles: has(configDir, profilesFile),
		has_poll_url: hasPollUrl,
	};
	return {
		configDir,
		ownerDir,
		identityPresent: identity.has_root_key || identity.has_profiles,
		identity,
	};
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
	const { api, logs, tools, services, channels, routes, hooks } = makeSpyApi(config);
	const register = await loadEntry();

	// The load-without-an-identity assertion: registerFull must not throw pre-onboarding.
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
					hooks,
					channelConfig: config?.channels?.rine ?? null,
					apiUrl: process.env.RINE_API_URL ?? null,
					...identityState(),
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
