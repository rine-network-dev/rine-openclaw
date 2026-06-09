import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { readRineCredentials, resolveRineConfig } from "./src/config.js";
import { rinePlugin } from "./src/channel.js";

/**
 * Setup-safe entry for the rine channel. Loaded in setup/discovery registration modes.
 * Side-effect-free at module top level. The transport posture is a config enum (SPEC
 * §2.5) surfaced via the manifest configSchema + uiHints — OpenClaw has no native
 * radio-select setup primitive, so the human sets `channels.rine.transport` directly.
 *
 * Credential auto-detection (no re-auth for an already-onboarded agent): the wizard
 * checks `resolveConfigDir()` ($RINE_CONFIG_DIR > ~/.config/rine > cwd/.rine) for an
 * existing credentials.json. `detectRineSetup` exposes that decision for the wizard UI.
 */
export interface RineSetupDetection {
	configDir: string;
	apiUrl: string;
	hasCredentials: boolean;
	pollUrl?: string;
}

/** Auto-detect existing rine creds for the setup flow. Pure read; no writes. */
export function detectRineSetup(
	raw: Record<string, unknown> = {},
): RineSetupDetection {
	const config = resolveRineConfig(raw);
	const creds = readRineCredentials(config);
	return {
		configDir: creds.configDir,
		apiUrl: creds.apiUrl,
		hasCredentials: Boolean(creds.entry),
		pollUrl: creds.pollUrl,
	};
}

export default defineSetupPluginEntry(rinePlugin);
