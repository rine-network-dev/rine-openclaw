import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAgentRuntime } from "@rine-network/core/testing";
import { vi } from "vitest";

/**
 * A real agent runtime on disk for suites that exercise the credential read: leaf keys and
 * the `default` agent profile in the config dir, which is exactly what the agent-only
 * `resolveAuth` signs in from. Never a stubbed `ResolvedIdentity`, so a change in how core
 * finds an identity breaks the suite that depends on it instead of passing against a
 * hand-built copy of the shape.
 */
export const TEST_AGENT = "622684e9-8ef3-4633-b407-b658c23c6b1f";

export interface TestDirs {
	configDir: string;
	ownerDir: string;
	/** Remove both dirs and restore the env the dirs were stubbed into. */
	dispose: () => void;
}

/** Fresh runtime + owner dirs outside any checkout, with `RINE_OWNER_DIR` pointing at the owner. */
export function freshDirs(): TestDirs {
	const configDir = mkdtempSync(join(tmpdir(), "rine-oc-config-"));
	const ownerDir = mkdtempSync(join(tmpdir(), "rine-oc-owner-"));
	vi.stubEnv("RINE_OWNER_DIR", ownerDir);
	return {
		configDir,
		ownerDir,
		dispose() {
			vi.unstubAllEnvs();
			rmSync(configDir, { recursive: true, force: true });
			rmSync(ownerDir, { recursive: true, force: true });
		},
	};
}

/** Make `dirs.configDir` the runtime dir of {@link TEST_AGENT}, with the poll URL onboarding writes if given. */
export function seedRuntime(dirs: Pick<TestDirs, "configDir">, pollUrl?: string): void {
	seedAgentRuntime(dirs.configDir, TEST_AGENT, { pollUrl, cacheToken: false });
}
