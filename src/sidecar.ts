import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { msgOf } from "./err.js";

/**
 * The per-agent JSON sidecar files this plugin keeps beside the rine runtime keys.
 *
 * A JSON sidecar (not OpenClaw's SQLite plugin-KV) is the shape this plugin
 * already had a reason for: rine is an external plugin with no SDK KV/state seam
 * (`api.runContext` is run-scoped, cleared on run end), and the config dir
 * already holds `profiles.json` / `token_cache.json` flat. This module is the
 * extraction of the write dance `transports/cursor.ts` owned alone until the
 * set-aside store needed the identical one — an exact duplicate removed, not an
 * abstraction anticipated, and both callers are in the same package.
 *
 * 🔴 Every path here is BEST-EFFORT and never throws. A missing, corrupt or
 * unwritable sidecar must degrade the feature it backs (one harmless SSE replay;
 * a set-aside entry that loses only its automatic retry) and never take an
 * inbound message down with it.
 *
 * 🔴 Where these files live, and why no mirror exclude is needed: the path is
 * always inside the resolved rine config dir, which is `RINE_CONFIG_DIR`,
 * `~/.config/rine` or `$PWD/.rine` — never inside `rine-openclaw/`.
 * `scripts/sync-packages.sh` rsyncs the package tree only, so it cannot reach
 * any of the three, and the root `.gitignore` ignores `.rine/` plus every
 * `.rine-` prefixed dir for the one resolution that can appear in a checkout.
 * (Spelling that second rule as a glob here would end this block comment
 * mid-sentence, which is what it did once.) Nothing here may move
 * under `rine-openclaw/rig/` — that path IS inside the package tree, and a new
 * sibling name there would be published to the public mirror.
 */

/**
 * Which sidecar. Named fields rather than three positional strings, because
 * `(configDir, prefix, agentId)` is three interchangeable strings at every call
 * site and two of them swapped reads as an empty first run.
 */
export interface SidecarLoc {
	configDir: string;
	/** The caller's literal (`sse_cursor`, `setaside`) — one agent's kinds never collide. */
	prefix: string;
	agentId: string;
}

/**
 * Where one agent's sidecar of a given kind lives.
 *
 * `agentId` is sanitized because an operator types it: it reaches this function
 * as a bare name, a `name@org` handle or a UUID, and `..` in it must not escape
 * the config dir.
 *
 * 🔴 Private, and called from INSIDE each caller's `try`. `join` throws on a
 * non-string, and a config dir this plugin was handed is not something a
 * best-effort read gets to assume: computing the path outside the guard is how
 * an extraction of this dance quietly turned a degrade-to-absent into a throw
 * on the inbound path. Nothing outside this file holds a sidecar path.
 */
function sidecarPath(loc: SidecarLoc): string {
	const stem = (loc.agentId || "default")
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, 128);
	return join(loc.configDir, `${loc.prefix}_${stem}.json`);
}

/**
 * Parse a sidecar, or `undefined` when there is nothing usable in it.
 *
 * ENOENT is the ordinary first-run case and is deliberately NOT logged — an
 * install that has never written a cursor or set anything aside would otherwise
 * emit a line per read. Every other failure, a corrupt file included, degrades
 * to `undefined` with one debug line.
 *
 * 🔴 It returns whatever parsed, cast to `T`. The file is 0600 in the agent's
 * own config dir rather than attacker-controlled input, but a torn write is
 * still possible, so a caller holding a SHAPE must validate it — see
 * `setaside.ts`'s own per-entry filter. Only the prefix reaches the log: the
 * full path carries the operator's home directory.
 */
export function readSidecar<T>(
	loc: SidecarLoc,
	logger?: PluginLogger,
): T | undefined {
	try {
		return JSON.parse(readFileSync(sidecarPath(loc), "utf-8")) as T;
	} catch (err) {
		if ((err as { code?: string }).code !== "ENOENT") {
			logger?.debug?.(
				`rine: sidecar ${loc.prefix} unreadable (${msgOf(err)}) — treating it as absent`,
			);
		}
		return undefined;
	}
}

/**
 * Replace a sidecar's contents via an atomic 0600 write in a 0700 directory.
 *
 * `renameSync` over a pid-suffixed temp file is what keeps a concurrent reader
 * from ever seeing half a document; the `chmodSync` after the rename is belt to
 * the `writeFileSync` mode's braces, because an existing target's mode survives
 * a rename on some platforms.
 */
export function writeSidecar(
	loc: SidecarLoc,
	value: unknown,
	logger?: PluginLogger,
): void {
	try {
		const path = sidecarPath(loc);
		const tmp = `${path}.${process.pid}.tmp`;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
		renameSync(tmp, path);
		chmodSync(path, 0o600);
	} catch (err) {
		logger?.debug?.(`rine: sidecar ${loc.prefix} save failed (${msgOf(err)})`);
	}
}
