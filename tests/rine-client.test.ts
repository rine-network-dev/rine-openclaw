import { PrincipalKind, pinsFor, principalString, saveProfiles } from "@rine-network/core";
import { FIXTURE_ORG_ID, seedOrgIdentity } from "@rine-network/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRineIdentity, resolveRineConfig } from "../src/config.js";
import { logger } from "./helpers.js";

const mockStartupEscrowSweep = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		startupEscrowSweep: (...args: unknown[]) => mockStartupEscrowSweep(...args),
	};
});

const { buildRineClient, operatorSetting } = await import("../src/rine-client.js");
import { TEST_AGENT as AGENT, type TestDirs, freshDirs, seedRuntime } from "./identity.js";

// The client is built once, at plugin registration. On a fresh install that happens
// BEFORE the agent calls rine_onboard, so the client must pick up an identity that
// appears afterwards — otherwise the only usable token is the one onboarding cached to
// disk, and every rine tool starts failing as soon as that token nears expiry.

const API = "https://rine.test";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";

let dirs: TestDirs;

function build() {
	return buildRineClient(
		readRineIdentity(resolveRineConfig({ configDir: dirs.configDir, baseUrl: API })),
	);
}

const tokenResponse = (token: string): Response =>
	new Response(JSON.stringify({ access_token: token, expires_in: 900 }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

beforeEach(() => {
	dirs = freshDirs();
	mockStartupEscrowSweep.mockReset();
	mockStartupEscrowSweep.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
	dirs.dispose();
});

describe("buildRineClient", () => {
	it("mints a token from an identity written after the client was built", async () => {
		const fetchMock = vi.fn(async () => tokenResponse("tok-after-onboard"));
		vi.stubGlobal("fetch", fetchMock);
		const client = build();

		await expect(client.getJwt()).rejects.toThrow(/No identity found/);
		expect(fetchMock).not.toHaveBeenCalled();

		seedRuntime(dirs);
		await expect(client.getJwt()).resolves.toBe("tok-after-onboard");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("signs the token request with a private_key_jwt and sends no client secret", async () => {
		const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
			tokenResponse("tok"),
		);
		vi.stubGlobal("fetch", fetchMock);
		seedRuntime(dirs);
		await build().getJwt();

		const body = String(fetchMock.mock.calls[0]?.[1]?.body);
		expect(body).toContain("client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer");
		expect(body).toContain("client_assertion=");
		expect(body).not.toContain("client_secret");
	});

	it("re-mints on a 401 for a client built before an identity existed", async () => {
		// canRefresh drives HttpClient's single forced retry. A client that captured an
		// absent identity could never refresh, so a 401 was terminal.
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
		const client = build();

		seedRuntime(dirs);
		await expect(client.fetchNewMessages(AGENT)).resolves.toEqual([{ id: "m1" }]);
		expect(issued).toBe(2);
	});

	it("pins the org of a client built with an identity, and re-pins after refreshIdentity", () => {
		const before = build();
		expect(pinsFor(before.client).ownOrgId).toBeUndefined();

		seedRuntime(dirs);
		before.toolContext.refreshIdentity();
		expect(pinsFor(before.client).ownOrgId).toBeTypeOf("string");

		expect(pinsFor(build().client).ownOrgId).toBe(pinsFor(before.client).ownOrgId);
	});

	it("hands the tools the owner dir alongside the config dir", () => {
		const client = build();
		expect(client.toolContext.configDir).toBe(dirs.configDir);
		expect(client.toolContext.ownerDir).toBe(dirs.ownerDir);
	});

	it("hands the tools the configured operator seat and a warning sink that names the plugin", () => {
		const pin = { agentId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", signingKey: "c2lnbmluZy1rZXk" };
		const log = logger();
		const creds = readRineIdentity(resolveRineConfig({ configDir: dirs.configDir, baseUrl: API }));

		const client = buildRineClient(creds, operatorSetting(resolveRineConfig({ operator: pin }), log));
		client.toolContext.operator?.warn("a replay");

		expect(client.toolContext.operator?.pin).toEqual(pin);
		expect(log.warn).toHaveBeenCalledWith("rine: a replay");
	});

	it("leaves the tools with no operator seat when none is given", () => {
		expect(build().toolContext.operator).toBeUndefined();
	});

	it("sweeps the escrow gaps a previous process left, for the agent the install acts as", async () => {
		seedRuntime(dirs);
		build().sweepEscrowAtStart();
		await Promise.resolve();

		expect(mockStartupEscrowSweep).toHaveBeenCalledOnce();
		expect(mockStartupEscrowSweep.mock.calls[0]?.[1]).toBe(dirs.configDir);
	});

	it("never throws or rejects when the sweep fails", async () => {
		mockStartupEscrowSweep.mockRejectedValue(new Error("boom"));
		const client = build();
		expect(() => client.sweepEscrowAtStart()).not.toThrow();
		await new Promise((r) => setTimeout(r, 0));
	});

	it("never throws when a runtime profile appears without its agent's keys", async () => {
		const client = build();
		saveProfiles(dirs.configDir, {
			default: {
				org_id: OTHER_ORG,
				principal: principalString({ kind: PrincipalKind.Agent, agentId: AGENT }),
				branch: "main",
				agent_id: AGENT,
			},
		});
		expect(() => client.sweepEscrowAtStart()).not.toThrow();
		await new Promise((r) => setTimeout(r, 0));
	});
});

/** The `iss` claim of the `client_assertion` the token request carried. */
function assertionIssuer(init: RequestInit | undefined): string {
	const assertion = new URLSearchParams(String(init?.body)).get("client_assertion") ?? "";
	const payload = assertion.split(".")[1] ?? "";
	return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).iss;
}

describe("the runtime signs in as the agent only", () => {
	it("keeps the agent as the token-assertion issuer while the owner dir holds an org root", async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => tokenResponse("tok"));
		vi.stubGlobal("fetch", fetchMock);
		seedRuntime(dirs);
		seedOrgIdentity(dirs.ownerDir);

		await build().getJwt();

		expect(assertionIssuer(fetchMock.mock.calls[0]?.[1])).toBe(
			principalString({ kind: PrincipalKind.Agent, agentId: AGENT }),
		);
	});

	it("does not sign in from an owner root alone", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => tokenResponse("tok")));
		seedOrgIdentity(dirs.ownerDir);

		await expect(build().getJwt()).rejects.toThrow(/No identity found/);
	});
});

describe("the onboarding tool context", () => {
	it("reads the owner root, which the runtime context never does", () => {
		seedOrgIdentity(dirs.ownerDir);
		const client = build();

		expect(pinsFor(client.onboardContext.client).ownOrgId).toBe(FIXTURE_ORG_ID);
		expect(pinsFor(client.client).ownOrgId).toBeUndefined();
	});

	it("gives onboarding its own client beside the same config and owner dirs", () => {
		const client = build();
		expect(client.onboardContext.configDir).toBe(dirs.configDir);
		expect(client.onboardContext.ownerDir).toBe(dirs.ownerDir);
		expect(client.onboardContext.client).not.toBe(client.client);
	});
});
