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
});
