import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCursor, saveCursor } from "../src/transports/cursor.js";

const created: string[] = [];
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "rine-cursor-"));
	created.push(dir);
	return dir;
}

afterEach(() => {
	for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("sse cursor persistence", () => {
	it("round-trips a saved event id", () => {
		const dir = tmp();
		saveCursor(dir, "agent-1", "m-42");
		expect(loadCursor(dir, "agent-1")).toBe("m-42");
	});

	it("returns undefined when no cursor file exists (first run)", () => {
		expect(loadCursor(tmp(), "agent-1")).toBeUndefined();
	});

	it("returns undefined (never throws) on a corrupt cursor file", () => {
		const dir = tmp();
		saveCursor(dir, "agent-1", "m-1");
		// Corrupt whatever file was written, found by listing — don't pin the naming scheme.
		const [file] = readdirSync(dir);
		writeFileSync(join(dir, file as string), "{not json");
		expect(loadCursor(dir, "agent-1")).toBeUndefined();
	});

	it("never escapes configDir for a traversal-shaped agentId", () => {
		const dir = tmp();
		saveCursor(dir, "../../etc/evil", "m-1");
		expect(loadCursor(dir, "../../etc/evil")).toBe("m-1");
		// The only file written stays inside dir (path separators neutralized).
		expect(readdirSync(dir)).toHaveLength(1);
		expect(existsSync(join(dir, "..", "etc"))).toBe(false);
	});

	it("creates a missing directory on save (recursive)", () => {
		const nested = join(tmp(), "deeper", "creds");
		expect(existsSync(nested)).toBe(false);
		saveCursor(nested, "agent-1", "m-7");
		expect(loadCursor(nested, "agent-1")).toBe("m-7");
	});

	it("keeps per-agent cursors independent in one dir", () => {
		const dir = tmp();
		saveCursor(dir, "agent-a", "m-a");
		saveCursor(dir, "agent-b", "m-b");
		expect(loadCursor(dir, "agent-a")).toBe("m-a");
		expect(loadCursor(dir, "agent-b")).toBe("m-b");
	});
});
