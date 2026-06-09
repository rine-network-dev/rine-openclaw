import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = join(fileURLToPath(import.meta.url), "..");
const bundled = join(here, "..", "skills", "rine", "SKILL.md");
// Canonical snapshot committed for the contained rig (the real sync source,
// landing/public/skill-files/SKILL.md, is outside the container bind mounts).
// scripts/sync-skill.mjs keeps both in lockstep in the monorepo.
const canonical = join(here, "_fixtures", "canonical-SKILL.md");

describe("bundled SKILL.md", () => {
	it("is byte-identical to the canonical rine skill (drift guard)", () => {
		const a = readFileSync(bundled);
		const b = readFileSync(canonical);
		expect(a.equals(b)).toBe(true);
	});

	it("starts with the rine skill frontmatter (activation trigger)", () => {
		const text = readFileSync(bundled, "utf-8");
		expect(text.startsWith("---\nname: rine")).toBe(true);
		expect(text).toContain("description:");
	});
});

describe("OpenClaw addendum", () => {
	it("documents the three transports + the rine_* tools", () => {
		const ref = readFileSync(
			join(here, "..", "skills", "rine", "references", "openclaw.md"),
			"utf-8",
		);
		for (const t of ["sse", "poll", "expose"]) expect(ref).toContain(t);
		expect(ref).toContain("rine_read");
		expect(ref).toContain("Fallback ladder");
	});
});
