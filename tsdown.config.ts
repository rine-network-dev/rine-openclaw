import { defineConfig } from "tsdown";

/**
 * tsdown build config. Entries/format/outDir mirror the old `build` npm script.
 *
 * `dts: false` — declarations are emitted by the separate `tsc --emitDeclarationOnly
 * -p tsconfig.build.json` step (which excludes `tests` and strips `@internal`), so the
 * shipped `.d.ts` never leaks test files or test-reset helpers.
 *
 * `inputOptions` force-clears `define` + `inject`: tsdown unconditionally injects both
 * as top-level rolldown input options, which rolldown v1.1.0 rejects ("Invalid key" —
 * they moved under `transform`). We define no compile-time constants and need no shims,
 * so dropping them is safe and silences the benign build warnings.
 *
 * `outputOptions` pins `transports/cursor.ts` (the SSE resume-cursor file I/O) into its
 * own chunk. Otherwise rolldown inlines it into the sse chunk — its only importer — so
 * the bundled file ends up with both `readFileSync` (cursor) and `fetch` (sse stream).
 * OpenClaw's install-time scanner has a coarse whole-file `potential-exfiltration` rule
 * ("file read + network send in one file") that then warns on every install. Keeping
 * cursor's disk I/O in a separate chunk from sse's network call clears the false positive
 * (and is cleaner separation anyway). No file co-resides both tokens after the split.
 */
export default defineConfig({
	entry: ["index.ts", "setup.ts"],
	format: "esm",
	outDir: "dist",
	clean: true,
	dts: false,
	inputOptions(options) {
		const opts = options as { define?: unknown; inject?: unknown };
		delete opts.define;
		delete opts.inject;
		return options;
	},
	outputOptions(options) {
		(options as { codeSplitting?: unknown }).codeSplitting = {
			groups: [{ name: "cursor", test: /cursor\.ts$/ }],
		};
		return options;
	},
});
