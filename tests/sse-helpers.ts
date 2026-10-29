import { vi } from "vitest";
import type { RineClient } from "../src/rine-client.js";
import type { TransportContext } from "../src/transports/context.js";
import type { RineConfig } from "../src/types.js";
import { logger, rineConfig } from "./helpers.js";

/*
 * Shared harness for the `runSseTransport` loop suites (`sse-loop`, `sse-replay-tags`,
 * `sse-connected-line`). Each suite mocks the poll fallback and the cursor store with
 * `vi.mock(path, async () => (await import("./sse-helpers.js")).pollModuleMock)` (and likewise
 * `cursorModuleMock`), so the spies below are the ones the transport sees.
 */

export const runPollSpy = vi.fn(async (_tc: unknown) => {});
// Cursor persistence is exercised directly in cursor.test.ts; here it is stubbed so the
// in-memory loop logic stays isolated (no fs) while still asserting the resume wiring.
export const loadCursorMock = vi.fn((_dir: string, _agentId: string): string | undefined => undefined);
export const saveCursorMock = vi.fn();

export const pollModuleMock = { runPollTransport: (tc: unknown) => runPollSpy(tc) };
export const cursorModuleMock = {
	loadCursor: (dir: string, agentId: string) => loadCursorMock(dir, agentId),
	// Forward only the behavioral args (dir, agentId, eventId) — the optional logger is
	// best-effort plumbing and must not be pinned by tests.
	saveCursor: (dir: string, agentId: string, eventId: string) => saveCursorMock(dir, agentId, eventId),
};

/** Restore every mock to its default; call from `afterEach`. */
export function resetSseMocks(): void {
	vi.restoreAllMocks();
	runPollSpy.mockReset();
	loadCursorMock.mockReset();
	loadCursorMock.mockReturnValue(undefined);
	saveCursorMock.mockReset();
}

function config(over: Partial<RineConfig> = {}): RineConfig {
	return rineConfig({
		pollIntervalMs: 5,
		reconnectBaseMs: 1,
		reconnectMaxMs: 5,
		...over,
	});
}

/** A body that yields one SSE block then ends (clean close). */
export function sseBody(block: string): { getReader: () => ReadableStreamDefaultReader<Uint8Array> } {
	let sent = false;
	return {
		getReader: () => ({
			read: async () => {
				if (sent) return { done: true, value: undefined };
				sent = true;
				return { done: false, value: new TextEncoder().encode(`${block}\n\n`) };
			},
			cancel: async () => {},
			releaseLock: () => {},
			closed: Promise.resolve(undefined),
		}) as unknown as ReadableStreamDefaultReader<Uint8Array>,
	};
}

/** A body that yields each block as its own chunk, in order, then ends (clean close). */
export function sseBodyBlocks(blocks: string[]): {
	getReader: () => ReadableStreamDefaultReader<Uint8Array>;
} {
	let i = 0;
	return {
		getReader: () =>
			({
				read: async () => {
					if (i >= blocks.length) return { done: true, value: undefined };
					const block = blocks[i++];
					return { done: false, value: new TextEncoder().encode(`${block}\n\n`) };
				},
				cancel: async () => {},
				releaseLock: () => {},
				closed: Promise.resolve(undefined),
			}) as unknown as ReadableStreamDefaultReader<Uint8Array>,
	};
}

/** A minimal MessageRead JSON for an SSE `event: message` frame with the given id. */
export function msgData(id: string): string {
	return JSON.stringify({
		id,
		conversation_id: `c-${id}`,
		type: "rine.v1.dm",
		encrypted_payload: "X",
		encryption_version: "hpke-hybrid-v2",
		sender_handle: "alice@lab",
	});
}

/** A message frame payload whose `created_at` is `ageMs` before now. */
export function msgDataAged(id: string, ageMs: number): string {
	return JSON.stringify({ ...JSON.parse(msgData(id)), created_at: new Date(Date.now() - ageMs).toISOString() });
}

/** Serve the bodies on successive connects, then fail every later connect (which ends the run in the poll fallback). */
export function serveBodies(bodies: Array<ReturnType<typeof sseBodyBlocks>>): void {
	let call = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			call < bodies.length ? { ok: true, status: 200, body: bodies[call++] } : { ok: false, status: 500, body: null },
		),
	);
}

export const infoLines = (tc: TransportContext): unknown[] =>
	(tc.logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

export function makeTc(over: Partial<RineConfig> = {}): { tc: TransportContext; ctrl: AbortController } {
	const ctrl = new AbortController();
	const client = {
		apiUrl: "https://rine.test",
		configDir: "/tmp/rine-test",
		getJwt: vi.fn(async () => "jwt"),
	} as unknown as RineClient;
	const tc: TransportContext = {
		client,
		config: config(over),
		agentId: "a1",
		logger: logger(),
		// Default: every message dispatches successfully (cursor may advance).
		onMessage: vi.fn(async () => true),
		signal: ctrl.signal,
	};
	return { tc, ctrl };
}
