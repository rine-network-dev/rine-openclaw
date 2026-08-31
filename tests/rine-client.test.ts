import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCreds } from "../src/config.js";
import { buildRineClient } from "../src/rine-client.js";

// The client is built once, at plugin registration. On a fresh install that happens
// BEFORE the agent calls rine_onboard, so the client must pick up credentials that
// appear afterwards — otherwise the only usable token is the one onboarding cached to
// disk, and every rine tool starts failing as soon as that token nears expiry.

const API = "https://rine.test";
const AGENT = "622684e9-8ef3-4633-b407-b658c23c6b1f";

let dir: string;

function uncredentialed(): ResolvedCreds {
	return { configDir: dir, apiUrl: API, entry: undefined, pollUrl: undefined };
}

function writeCredentials(): void {
	writeFileSync(
		join(dir, "credentials.json"),
		JSON.stringify({ default: { client_id: "cid", client_secret: "csecret" } }),
	);
}

const tokenResponse = (token: string): Response =>
	new Response(JSON.stringify({ access_token: token, expires_in: 900 }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rine-oc-client-"));
	// Env credentials would short-circuit the config-dir lookup under test.
	vi.stubEnv("RINE_CLIENT_ID", "");
	vi.stubEnv("RINE_CLIENT_SECRET", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

describe("buildRineClient", () => {
	it("mints a token from credentials written after the client was built", async () => {
		const fetchMock = vi.fn(async () => tokenResponse("tok-after-onboard"));
		vi.stubGlobal("fetch", fetchMock);
		const client = buildRineClient(uncredentialed());

		await expect(client.getJwt()).rejects.toThrow(/No credentials found/);
		expect(fetchMock).not.toHaveBeenCalled();

		writeCredentials();
		await expect(client.getJwt()).resolves.toBe("tok-after-onboard");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("re-mints on a 401 for a client built before credentials existed", async () => {
		// canRefresh drives HttpClient's single forced retry. A client that captured an
		// absent credential entry could never refresh, so a 401 was terminal.
		let issued = 0;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/oauth/token")) return tokenResponse(`tok-${++issued}`);
			if (issued < 2) return new Response("{}", { status: 401 });
			return new Response(JSON.stringify({ items: [{ id: "m1" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const client = buildRineClient(uncredentialed());

		writeCredentials();
		await expect(client.fetchNewMessages(AGENT)).resolves.toEqual([{ id: "m1" }]);
		expect(issued).toBe(2);
	});
});
