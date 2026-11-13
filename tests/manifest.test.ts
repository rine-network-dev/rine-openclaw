import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { SETASIDE_SWEEP_INTERVAL_MS } from "../src/constants.js";
import { EXPOSED_TOOLS, OPTIONAL_TOOLS } from "../src/tools.js";

const here = join(fileURLToPath(import.meta.url), "..");

// ONE read of the sibling package.json, with ONE structural type. Four tests below assert
// on it; four inline `JSON.parse(readFileSync(...)) as {…}` casts each declared a different
// subset of the same file, so a field added to one cast stayed invisible to the other three
// and a new assertion got a fresh `as` clause instead of a compile error.
type PluginPackageJson = {
	version?: string;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	openclaw?: {
		compat?: Record<string, string>;
		build?: Record<string, string>;
		install?: Record<string, string>;
	};
};

const pkg = JSON.parse(
	readFileSync(join(here, "..", "package.json"), "utf-8"),
) as PluginPackageJson;

describe("openclaw.plugin.json", () => {
	it("declares the channel kind + rine channel + bundled skill", () => {
		expect(manifest.id).toBe("rine");
		expect(manifest.kind).toBe("channel");
		expect(manifest.channels).toContain("rine");
		expect(manifest.skills).toContain("skills/rine");
	});

	it("sets activation.onStartup explicitly true", () => {
		expect(manifest.activation).toEqual({ onStartup: true });
	});

	it("contracts.tools lists exactly the exposed tools", () => {
		expect([...manifest.contracts.tools].sort()).toEqual([...EXPOSED_TOOLS].sort());
	});

	it("marks exactly the code's optional tools optional in toolMetadata", () => {
		// OpenClaw ORs the manifest flag with the one passed to registerTool, so a stale
		// manifest entry silently re-gates a tool the code ungated.
		const meta = manifest.toolMetadata as Record<string, { optional?: boolean }>;
		for (const name of EXPOSED_TOOLS) {
			const expectOptional = OPTIONAL_TOOLS.has(name);
			expect(Boolean(meta[name]?.optional)).toBe(expectOptional);
		}
	});

	it("declares no optional tool the code does not also gate (set equality, both ways)", () => {
		// The loop above walks EXPOSED_TOOLS, so a manifest entry for a name that is
		// not exposed — a rename, or a tool dropped from the array — would slip past
		// it. OpenClaw ORs the two gates, so the sets must be equal, not merely
		// consistent on the names one of them happens to list.
		const meta = manifest.toolMetadata as Record<string, { optional?: boolean }>;
		const fromManifest = Object.entries(meta)
			.filter(([, v]) => v?.optional)
			.map(([k]) => k)
			.sort();
		expect(fromManifest).toEqual([...OPTIONAL_TOOLS].sort());
	});

	it("gates the four third-party-effect group verbs in the manifest too, and no other", () => {
		// Named literally rather than derived from OPTIONAL_TOOLS: the set-equality test
		// above proves the two gates agree with each other, and this one proves they agree
		// with the gating rule itself. Derived from the code, both would drift in silence.
		const GATED_GROUP = [
			"rine_group_invite",
			"rine_group_vote",
			"rine_group_remove",
			"rine_group_reclaim",
		];
		const meta = manifest.toolMetadata as Record<string, { optional?: boolean }>;
		for (const name of GATED_GROUP) expect(meta[name]?.optional).toBe(true);
		for (const name of EXPOSED_TOOLS.filter(
			(n) => n.startsWith("rine_group") && !GATED_GROUP.includes(n),
		)) {
			expect(meta[name]).toBeUndefined();
		}
	});

	it("leaves rine_onboard ungated so a fresh install can register itself", () => {
		// With the default (empty) tool allowlist OpenClaw offers non-optional plugin tools
		// and withholds optional ones. rine_onboard must therefore carry neither gate.
		const meta = manifest.toolMetadata as Record<string, { optional?: boolean }>;
		expect(meta.rine_onboard).toBeUndefined();
		expect(OPTIONAL_TOOLS.has("rine_onboard")).toBe(false);
		expect([...manifest.contracts.tools]).toContain("rine_onboard");
	});

	it("configSchema.transport is an enum defaulting to sse", () => {
		const t = manifest.configSchema.properties.transport;
		expect(t.enum).toEqual(["expose", "sse", "poll"]);
		expect(t.default).toBe("sse");
	});

	it("configSchema declares healthMonitor.enabled (thin-channel opt-out, recommended false)", () => {
		// Without this schema entry, `openclaw config validate` rejects
		// channels.rine.healthMonitor as an additional property (strict schema). The
		// channelConfigs-matches-configSchema test below guards the two copies stay in sync.
		const hm = manifest.configSchema.properties.healthMonitor;
		expect(hm.properties.enabled.type).toBe("boolean");
		expect(hm.properties.enabled.default).toBe(false);
	});

	it("declares the set-aside sweep interval, defaulted from the code's own constant", () => {
		// 🔴 Both halves matter. The DECLARATION, because the schema is
		// `additionalProperties: false`: an operator who sets a key the manifest does
		// not list gets a hard config error, so an undeclared knob is not a knob. The
		// DEFAULT, because it is written twice — once as a number the host shows the
		// operator, once as the constant the channel actually runs on — and a manifest
		// that advertises five minutes while the code sweeps on ten is a lie no suite
		// would otherwise notice.
		const p = manifest.configSchema.properties.setasideSweepIntervalMs;
		expect(p.type).toBe("number");
		expect(p.default).toBe(SETASIDE_SWEEP_INTERVAL_MS);
		// A floor rather than none: zero is a spinning timer, and the host refuses it
		// here before `config.ts` has to. `hermes_rine` guards the same knob in seconds.
		expect(p.minimum).toBe(1000);
		expect(p.minimum).toBeLessThan(SETASIDE_SWEEP_INTERVAL_MS);
	});

	it("channelConfigs.rine.schema is inlined (no $ref) and matches configSchema", () => {
		// A `{"$ref":"#/configSchema"}` here does NOT resolve on the pinned host: the plugin
		// schema validator is handed `channelConfigs.rine.schema` as the whole document, so
		// `#/configSchema` is looked up INSIDE that object and never reaches the sibling
		// top-level manifest key. The channel schema must be inlined; this guards against a
		// regression to `$ref` and against the two copies drifting out of sync.
		const rine = (manifest.channelConfigs as Record<string, { schema?: unknown }>).rine;
		const schema = rine?.schema;
		expect(schema).toBeDefined();
		expect(JSON.stringify(schema)).not.toContain("$ref");
		expect(schema).toEqual(manifest.configSchema);
	});

	it("channels.rine.operator is declared as a strict agentId + signingKey pair with an optional handle, in both schemas", () => {
		// The channel schema is closed (`additionalProperties: false`), so a pin the schema does
		// not declare is a hard config error on the host, and one declared loosely would let a
		// half-written pin through to a trust decision.
		const rine = (manifest.channelConfigs as Record<string, { schema: typeof manifest.configSchema }>).rine;
		for (const schema of [manifest.configSchema, rine!.schema]) {
			const operator = (schema.properties as Record<string, unknown>).operator as {
				type: string;
				required: string[];
				additionalProperties: boolean;
				properties: Record<string, { type: string }>;
			};
			expect(operator.type).toBe("object");
			expect([...operator.required].sort()).toEqual(["agentId", "signingKey"]);
			expect(operator.additionalProperties).toBe(false);
			expect(operator.properties.agentId?.type).toBe("string");
			expect(operator.properties.signingKey?.type).toBe("string");
			expect(operator.properties.handle?.type).toBe("string");
		}
	});

	it("package.json keeps openclaw as a peer/dev dep only (never a runtime dependency)", () => {
		expect(pkg.dependencies?.openclaw).toBeUndefined();
		expect(pkg.peerDependencies?.openclaw).toBeDefined();
		expect(pkg.devDependencies?.openclaw).toBeDefined();
	});

	it("openclaw version-floor fields use a >= semver floor (the installer rejects bare versions)", () => {
		const oc = pkg.openclaw ?? {};
		// `install.minHostVersion` is the hard one: the host parses it with a regex that
		// accepts only `>=x.y.z`, and a bare version makes the whole manifest invalid, so
		// the plugin is skipped at load. `compat.pluginApi` is parsed as a semver RANGE
		// (a bare version there would silently mean "exactly this host"), and
		// `compat.minGatewayVersion` is read on the ClawHub path with the legacy bare form
		// still tolerated. All three are floors by intent; assert the floor form on all
		// three so none of them can drift into an exact pin.
		expect(oc.compat?.pluginApi).toMatch(/^>=/);
		expect(oc.compat?.minGatewayVersion).toMatch(/^>=/);
		expect(oc.install?.minHostVersion).toMatch(/^>=/);
	});

	it("the declared floor is one value, the build fields match the pin, and the pin meets the floor", () => {
		// Two versions, each written in one place. The FLOOR is the oldest host a user may
		// run: `compat.*`, `install.minHostVersion` and the peer dependency all state it, so
		// they must agree with each other or the installer, ClawHub and npm each enforce a
		// different minimum. The PIN is the host every gating rig builds and tests against:
		// `build.*` describes that host, so it must equal `devDependencies.openclaw`. The pin
		// may sit above the floor, never below it: a floor above the tested host describes a
		// host nothing ran on. Only the advisory canary (`scripts/canary-latest.sh <floor>`)
		// executes the floor itself.
		const pinned = pkg.devDependencies?.openclaw;
		expect(pinned).toMatch(/^\d{4}\.\d+\.\d+$/);
		const oc = pkg.openclaw ?? {};
		const floor = oc.install?.minHostVersion;
		expect(floor).toMatch(/^>=\d{4}\.\d+\.\d+$/);
		expect(oc.compat?.pluginApi).toBe(floor);
		expect(oc.compat?.minGatewayVersion).toBe(floor);
		expect(pkg.peerDependencies?.openclaw).toBe(floor);
		expect(oc.build?.openclawVersion).toBe(pinned);
		expect(oc.build?.pluginSdkVersion).toBe(pinned);
		// Zero-padded segments make a string comparison a numeric one (2026.10.0 > 2026.9.6).
		const sortKey = (v = "") =>
			v.replace(/^>=/, "").split(".").map((n) => n.padStart(6, "0")).join(".");
		expect(sortKey(pinned) >= sortKey(floor)).toBe(true);
	});

	it("openclaw.plugin.json version matches package.json version", () => {
		// The host prefers the plugin manifest's version over the package version
		// (`manifest.version ?? packageVersion`), so a stale manifest makes
		// `openclaw plugins list` report a version that was never published. The two
		// drifted once already: package.json 0.6.1, manifest 0.6.0.
		expect(manifest.version).toBe(pkg.version);
	});
});
