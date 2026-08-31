import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRineSetup } from "../setup.js";

describe("detectRineSetup", () => {
	const created: string[] = [];
	afterEach(() => {
		for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
		delete process.env.RINE_CONFIG_DIR;
		delete process.env.RINE_CLIENT_ID;
		delete process.env.RINE_CLIENT_SECRET;
	});

	function freshDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "rine-setup-"));
		created.push(dir);
		return dir;
	}

	it("reports hasCredentials: false for an empty config dir", () => {
		delete process.env.RINE_CLIENT_ID;
		delete process.env.RINE_CLIENT_SECRET;
		const dir = freshDir();
		const det = detectRineSetup({ configDir: dir });
		expect(det.configDir).toBe(dir);
		expect(det.hasCredentials).toBe(false);
		expect(det.pollUrl).toBeUndefined();
	});

	it("reports hasCredentials: true when credentials.json has a default entry", () => {
		delete process.env.RINE_CLIENT_ID;
		delete process.env.RINE_CLIENT_SECRET;
		const dir = freshDir();
		writeFileSync(
			join(dir, "credentials.json"),
			JSON.stringify({ default: { client_id: "cid", client_secret: "csec", poll_url: "https://poll" } }),
		);
		const det = detectRineSetup({ configDir: dir, baseUrl: "https://api.test" });
		expect(det.hasCredentials).toBe(true);
		expect(det.apiUrl).toBe("https://api.test");
		expect(det.pollUrl).toBe("https://poll");
	});

	it("does not mutate process.env.RINE_CONFIG_DIR (pure read)", () => {
		delete process.env.RINE_CONFIG_DIR;
		const dir = freshDir();
		detectRineSetup({ configDir: dir });
		expect(process.env.RINE_CONFIG_DIR).toBeUndefined();
	});
});
