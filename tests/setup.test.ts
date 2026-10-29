import { afterEach, describe, expect, it } from "vitest";
import { detectRineSetup } from "../setup.js";
import { type TestDirs, freshDirs, seedRuntime } from "./identity.js";

describe("detectRineSetup", () => {
	const created: TestDirs[] = [];
	afterEach(() => {
		for (const d of created.splice(0)) d.dispose();
		delete process.env.RINE_CONFIG_DIR;
	});

	function fresh(): TestDirs {
		const dirs = freshDirs();
		created.push(dirs);
		return dirs;
	}

	it("reports hasIdentity: false for an empty config dir", () => {
		const dirs = fresh();
		const det = detectRineSetup({ configDir: dirs.configDir });
		expect(det.configDir).toBe(dirs.configDir);
		expect(det.hasIdentity).toBe(false);
		expect(det.pollUrl).toBeUndefined();
	});

	it("reports hasIdentity: true when the runtime dir holds an agent profile and its keys", () => {
		const dirs = fresh();
		seedRuntime(dirs, "https://poll");
		const det = detectRineSetup({ configDir: dirs.configDir, baseUrl: "https://api.test" });
		expect(det.hasIdentity).toBe(true);
		expect(det.apiUrl).toBe("https://api.test");
		expect(det.pollUrl).toBe("https://poll");
	});

	it("does not mutate process.env.RINE_CONFIG_DIR (pure read)", () => {
		delete process.env.RINE_CONFIG_DIR;
		const dirs = fresh();
		detectRineSetup({ configDir: dirs.configDir });
		expect(process.env.RINE_CONFIG_DIR).toBeUndefined();
	});
});
