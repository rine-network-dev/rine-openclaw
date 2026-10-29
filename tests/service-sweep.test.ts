import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "./helpers.js";
import { type TestDirs, freshDirs, seedRuntime } from "./identity.js";

const mockStartupEscrowSweep = vi.fn();
const mockRunExposeTransport = vi.fn(async () => {});

vi.mock("@rine-network/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...orig,
		startupEscrowSweep: (...args: unknown[]) => mockStartupEscrowSweep(...args),
	};
});
vi.mock("../src/transports/expose.js", () => ({
	runExposeTransport: () => mockRunExposeTransport(),
}));

const { makeRineService } = await import("../src/service.js");

// The start-up sweep clears the escrow files a previous process left behind. It runs once
// per notify-service start, after the agent to bind is known, and never on the send path.

const AGENT_ID = "622684e9-8ef3-4633-b407-b658c23c6b1f";

let dirs: TestDirs;

function api(): OpenClawPluginApi {
	return {
		config: {
			channels: {
				rine: {
					configDir: dirs.configDir,
					baseUrl: "https://rine.test",
					transport: "expose",
					pollIntervalMs: 20,
				},
			},
		},
		runtime: { channel: {} },
		logger: logger(),
	} as unknown as OpenClawPluginApi;
}

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for service state");
		await new Promise((r) => setTimeout(r, 10));
	}
}

function stubServer(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const body = String(input).endsWith("/oauth/token")
				? { access_token: "tok", expires_in: 900 }
				: { items: [{ id: AGENT_ID, name: "maggs", handle: "maggs@x" }] };
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
}

beforeEach(() => {
	dirs = freshDirs();
	vi.stubEnv("RINE_AGENT", "");
	mockStartupEscrowSweep.mockReset();
	mockStartupEscrowSweep.mockResolvedValue(undefined);
	mockRunExposeTransport.mockClear();
});

afterEach(() => {
	vi.unstubAllGlobals();
	dirs.dispose();
});

describe("notify service start-up escrow sweep", () => {
	it("sweeps once, before the transport runs, once the agent to bind is resolved", async () => {
		seedRuntime(dirs);
		stubServer();
		const service = makeRineService(api());
		service.start({ logger: logger() } as never);

		await until(() => mockRunExposeTransport.mock.calls.length > 0);
		expect(mockStartupEscrowSweep).toHaveBeenCalledOnce();
		expect(mockStartupEscrowSweep.mock.calls[0]?.[1]).toBe(dirs.configDir);
		service.stop?.({ logger: logger() } as never);
	});

	it("does not sweep while the install has no identity", async () => {
		stubServer();
		const service = makeRineService(api());
		service.start({ logger: logger() } as never);

		await new Promise((r) => setTimeout(r, 120));
		expect(mockStartupEscrowSweep).not.toHaveBeenCalled();
		expect(mockRunExposeTransport).not.toHaveBeenCalled();
		service.stop?.({ logger: logger() } as never);
	});
});
