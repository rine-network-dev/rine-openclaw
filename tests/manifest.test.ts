import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { EXPOSED_TOOLS, OPTIONAL_TOOLS } from "../src/tools.js";

const here = join(fileURLToPath(import.meta.url), "..");

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

	it("marks send/onboard optional in toolMetadata (matches code)", () => {
		const meta = manifest.toolMetadata as Record<string, { optional?: boolean }>;
		for (const name of EXPOSED_TOOLS) {
			const expectOptional = OPTIONAL_TOOLS.has(name);
			expect(Boolean(meta[name]?.optional)).toBe(expectOptional);
		}
	});

	it("configSchema.transport is an enum defaulting to sse", () => {
		const t = manifest.configSchema.properties.transport;
		expect(t.enum).toEqual(["expose", "sse", "poll"]);
		expect(t.default).toBe("sse");
	});

	it("package.json keeps openclaw as a peer/dev dep only (never a runtime dependency)", () => {
		const pkg = JSON.parse(
			readFileSync(join(here, "..", "package.json"), "utf-8"),
		) as {
			dependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		expect(pkg.dependencies?.openclaw).toBeUndefined();
		expect(pkg.peerDependencies?.openclaw).toBeDefined();
		expect(pkg.devDependencies?.openclaw).toBeDefined();
	});

	it("openclaw version-floor fields use a >= semver floor (the installer rejects bare versions)", () => {
		const pkg = JSON.parse(
			readFileSync(join(here, "..", "package.json"), "utf-8"),
		) as {
			openclaw?: {
				compat?: Record<string, string>;
				install?: Record<string, string>;
			};
		};
		const oc = pkg.openclaw ?? {};
		// Verified against a live 2026.6.1 gateway: a bare "2026.6.1" floor fails
		// `openclaw plugins install` validation ("must use a semver floor >=x.y.z").
		expect(oc.compat?.pluginApi).toMatch(/^>=/);
		expect(oc.compat?.minGatewayVersion).toMatch(/^>=/);
		expect(oc.install?.minHostVersion).toMatch(/^>=/);
	});
});
