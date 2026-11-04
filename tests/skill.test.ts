import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPOSED_TOOLS, OPTIONAL_TOOLS } from "../src/tools.js";

const here = join(fileURLToPath(import.meta.url), "..");
const skillDir = join(here, "..", "skills", "rine");
const bundled = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
const addendum = readFileSync(
  join(skillDir, "references", "openclaw.md"),
  "utf-8",
);

/** Every `rine_*` name mentioned in `text`, deduplicated. */
function mentionedTools(text: string): string[] {
  return [...new Set(text.match(/rine_[a-z_]+/g) ?? [])];
}

/**
 * `text` as one line, so a sentence assertion is not a line-wrap assertion.
 * These files are hand-wrapped at ~90 columns and a sentence the skill states
 * is usually split across two of them; asserting the raw string would pass or
 * fail on where the wrap happens to land, which is not what is being pinned.
 */
const oneLine = (text: string) => text.replace(/\s+/g, " ");
const flatBundled = oneLine(bundled);
const flatAddendum = oneLine(addendum);

describe("bundled SKILL.md", () => {
  it("starts with the rine skill frontmatter (activation trigger)", () => {
    expect(bundled.startsWith("---\nname: rine")).toBe(true);
    expect(bundled).toContain("description:");
  });

  it("names only tools this plugin exposes", () => {
    const exposed = new Set<string>(EXPOSED_TOOLS);
    expect(mentionedTools(bundled).filter((t) => !exposed.has(t))).toEqual([]);
  });

  it("teaches the channel wake path, not polling", () => {
    expect(bundled).toContain("wakes an agent turn");
    expect(bundled).not.toContain("poll_url");
  });

  it("states that onboarding needs no allowlist step", () => {
    expect(bundled).toMatch(
      /rine_onboard[\s\S]{0,120}No allowlist step needed/,
    );
  });

  it("names every group tool this plugin exposes", () => {
    // The skill is hand-authored per host. A group verb the plugin offers and the
    // skill never names is a tool the model does not know it has.
    for (const name of EXPOSED_TOOLS.filter(
      (n) => n.startsWith("rine_group") || n === "rine_discover_groups",
    )) {
      expect(bundled).toContain(name);
    }
  });

  it("tells the agent which group verbs the operator must allowlist first", () => {
    // Derived, not listed: a verb gated in code but left in the always-available
    // section of the skill is a tool the model will try and never be offered.
    const gated = bundled.slice(
      bundled.indexOf("Available once the operator allowlists"),
    );
    for (const name of EXPOSED_TOOLS.filter(
      (n) => n.startsWith("rine_group") && OPTIONAL_TOOLS.has(n),
    ))
      expect(gated).toContain(name);
  });

  it("says an open group is not post-quantum while the MLS ones are", () => {
    expect(bundled).toMatch(/open group runs Sender Keys/);
    expect(bundled).toMatch(/post-quantum MLS on the X-Wing suite/);
  });

  it("never calls removal or reclamation admin-gated", () => {
    // Any member may post the commit; the deterrent is the O(N) cost, not a role.
    expect(bundled).not.toMatch(/admin-(initiated|gated)/i);
    expect(bundled).not.toMatch(/expiry bounds the tree/i);
  });

  // The bundled skill is prose a model reads raw, and it once stated the
  // invite bypass as a virtue — "it seats them outright: no request, no vote, no
  // other member". That sentence is false on a majority or unanimity group: it
  // would tell a model an agent is in when the electorate has yet to decide.
  it("never says an invite seats outright with no vote and no other member", () => {
    for (const text of [flatBundled, flatAddendum]) {
      expect(text).not.toMatch(/no request, no vote, no other member/i);
      expect(text).not.toMatch(/no threshold and no other member/i);
      expect(text).not.toMatch(/needs no pending request/i);
    }
  });

  it("says an invite to a voting group nominates, and who decides it", () => {
    expect(flatBundled).toContain(
      "On a majority or unanimity group it nominates instead: it files a join request the electorate decides",
    );
    // The founding-roster carve-out, stated as a rule rather than met as an inconsistency.
    expect(flatBundled).toContain(
      "mints real invitations under every enrolment policy, majority and unanimity included",
    );
    expect(flatBundled).toContain(
      "at founding you are the only member and therefore the whole electorate",
    );
  });

  it("states the denial bar beside the approval one", () => {
    // The denial bar is measured against the same shrinking electorate as the
    // approval one, so both fall as members leave — and a skill that names only
    // the approval half cannot explain a request its standing denials refused.
    for (const text of [flatBundled, flatAddendum]) {
      expect(text).toContain("Denials refuse it on that same electorate");
      expect(text).toContain("so both bars fall as members leave");
    }
  });

  it("no longer claims this host cannot manage groups", () => {
    const limits = bundled.slice(bundled.indexOf("## Limits of this host"));
    expect(limits).not.toContain("Group management");
  });

  it("does not list leaf reclamation among the verbs this host lacks", () => {
    // rine_group_reclaim ships here now; a limits section that still sends the
    // human to the CLI for it costs the group the leaves nobody retires.
    const limits = bundled.slice(bundled.indexOf("## Limits of this host"));
    expect(limits).not.toMatch(/reclamation/i);
  });
});

describe("OpenClaw addendum", () => {
  it("documents the three transports + the rine_* tools", () => {
    for (const t of ["sse", "poll", "expose"]) expect(addendum).toContain(t);
    expect(addendum).toContain("rine_read");
    expect(addendum).toContain("Fallback ladder");
  });

  it("names only tools this plugin exposes", () => {
    const exposed = new Set<string>(EXPOSED_TOOLS);
    expect(mentionedTools(addendum).filter((t) => !exposed.has(t))).toEqual([]);
  });

  it("names every tool the plugin exposes — it is the operator's inventory", () => {
    const named = new Set(mentionedTools(addendum));
    expect([...EXPOSED_TOOLS].filter((t) => !named.has(t))).toEqual([]);
  });

  it("marks exactly the allowlist-gated tools as gated in the inventory", () => {
    for (const line of addendum.split("\n")) {
      const name = line.match(/^- `(rine_[a-z_]+)`/)?.[1];
      if (!name) continue;
      expect(line.includes("*(allowlist-gated)*")).toBe(
        OPTIONAL_TOOLS.has(name),
      );
    }
  });
});
