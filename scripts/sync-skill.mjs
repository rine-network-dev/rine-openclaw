#!/usr/bin/env node
// Copies the canonical rine SKILL.md into the plugin's bundled skill dir, byte-identically.
// Source of truth: landing/public/skill-files/SKILL.md (one skill, runs in CC + OpenClaw).
// The drift-guard test (tests/skill.test.ts) fails if the bundled copy diverges.
//
// Modes:
//   node scripts/sync-skill.mjs           # write: copy canonical → bundled
//   node scripts/sync-skill.mjs --check   # verify only: exit 1 if the bundled copy
//                                          # would change (CI guard for un-synced edits)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..");
// Monorepo layout: rine-openclaw/ sits next to landing/.
const CANONICAL = join(pluginRoot, "..", "landing", "public", "skill-files", "SKILL.md");
const DEST = join(pluginRoot, "skills", "rine", "SKILL.md");

const checkOnly = process.argv.includes("--check");
const source = readFileSync(CANONICAL);

if (checkOnly) {
	const current = existsSync(DEST) ? readFileSync(DEST) : Buffer.alloc(0);
	if (!current.equals(source)) {
		console.error(
			`drift: ${DEST} is out of sync with ${CANONICAL}. Run \`npm run sync-skill\` and commit.`,
		);
		process.exit(1);
	}
	console.log("SKILL.md in sync");
	process.exit(0);
}

mkdirSync(dirname(DEST), { recursive: true });
writeFileSync(DEST, source);
console.log(`synced SKILL.md (${source.length} bytes) -> ${DEST}`);
