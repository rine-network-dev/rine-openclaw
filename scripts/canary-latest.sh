#!/usr/bin/env bash
# canary-latest.sh — ADVISORY floating-version canary for the OpenClaw plugin.
#
# WHY THIS EXISTS. `compose.openclaw.yml`'s pinned lane installs the exact devDependency
# `openclaw@2026.9.6`, while `peerDependencies.openclaw` is `>=2026.9.1` — the pin and the
# floor are no longer equal. The canary's control run is `canary-latest.sh 2026.9.1` (the
# floor); its default run is `latest`. Every assertion in the pinned lane — including the
# tool-admission assertions `e2e-onboard.sh` makes in its "plugin loads with NO identity"
# section — is against a FROZEN version, which by construction cannot catch drift away from
# it. This lane installs whatever openclaw ships TODAY and re-runs the plugin's real load +
# tool-admission path against it. When the pin and `latest` are the same version a green
# canary is a tautology; it earns its keep on the first upstream release after the pin.
#
# ADVISORY, NOT BLOCKING. A red canary is upstream news, not our regression: the published
# openclaw changed under a plugin whose source did not. It is deliberately NOT wired into
# `scripts/ci.sh` or the pre-push hook. Run it on demand, and when it fails read the upstream
# version it names before touching plugin code.
#
# ALL OpenClaw execution happens inside the contained rig (compose.openclaw.yml +
# compose.openclaw.canary.yml), on its OWN node_modules volume so the pinned lane keeps testing
# the pinned devDependency (2026.9.6). Nothing OpenClaw-related is installed on the host.
# Section 4 sources canary-install.sh: it runs the REAL `openclaw plugins install` chain with
# no TTY — the documented command from the README, then a locally packed tarball.
#
# Run:  bash rine-openclaw/scripts/canary-latest.sh            # openclaw@latest
#       bash rine-openclaw/scripts/canary-latest.sh 2026.9.1   # the peer floor (control run)
#       bash rine-openclaw/scripts/canary-latest.sh beta       # any npm dist-tag or version
#       CANARY_FRESH=false bash rine-openclaw/scripts/canary-latest.sh   # reuse last install
# Prereq: the plugin dist must be built (the pinned lane's build is reused verbatim) —
#   docker compose -f compose.openclaw.yml run --rm plugin npm install && … npm run build
# Exit: 0 = plugin survives that version · 1 = drift detected (advisory) · 2 = rig/setup error.

set -uo pipefail

SPEC="${1:-latest}"
CANARY_FRESH="${CANARY_FRESH:-true}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$PLUGIN_DIR/.." && pwd)"

PEER_RANGE=$(jq -r '.peerDependencies.openclaw' "$PLUGIN_DIR/package.json")
PINNED=$(jq -r '.devDependencies.openclaw' "$PLUGIN_DIR/package.json")

if [[ ! -f "$PLUGIN_DIR/dist/index.js" ]]; then
    echo "FATAL: $PLUGIN_DIR/dist/index.js missing — build the plugin dist first:"
    echo "  docker compose -f compose.openclaw.yml run --rm plugin npm install"
    echo "  docker compose -f compose.openclaw.yml run --rm plugin npm run build"
    exit 2
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT INT TERM
export CANARY_UID="$(id -u)" CANARY_GID="$(id -g)"
export CANARY_STATE_DIR="$WORKDIR/oc-state" CANARY_CREDS_DIR="$WORKDIR/oc-rine"
mkdir -p "$CANARY_STATE_DIR" "$CANARY_CREDS_DIR"
# Same tracked, known-working gateway config the from-scratch E2E uses (channels.rine block +
# plugins.load.paths) — the canary changes the openclaw VERSION, nothing else.
cp "$PLUGIN_DIR/rig-e2e/openclaw.json" "$CANARY_STATE_DIR/openclaw.json"

COMPOSE=(docker compose -f "$PROJECT_ROOT/compose.openclaw.yml"
         -f "$PROJECT_ROOT/compose.openclaw.canary.yml")
oc() { "${COMPOSE[@]}" run --rm --entrypoint sh plugin -c "$1" 2>&1 |
       grep -vE '^(\[|Creating|Container |Network |Volume )|npm_config'; }
# Docker creates a named volume root-owned, but the rig must run as the host uid (see the
# compose override header), so npm cannot write into it. One-shot root chown of the volume
# mountpoint only — never the bind-mounted source tree.
oc_own() { "${COMPOSE[@]}" run --rm --user root --entrypoint sh plugin \
             -c "chown $CANARY_UID:$CANARY_GID /work/rine-openclaw/node_modules" >/dev/null 2>&1; }

RESOLVED="(not installed)"
FAILURES=()
ok()   { echo "  PASS: $1"; }
drift() { echo "  DRIFT: $1"; [[ -n "${2:-}" ]] && echo "         $2"; FAILURES+=("$1"); }

echo "============================================"
echo "  OpenClaw floating-version CANARY (advisory) — $(date -Iseconds)"
echo "  requested spec : openclaw@$SPEC"
echo "  rig pins       : $PINNED   (what every other lane tests)"
echo "  users may run  : $PEER_RANGE"
echo "============================================"

# ---------------------------------------------------------------------------
echo ""; echo "=== 1 · install openclaw@$SPEC inside the rig (own volume) ==="
# ---------------------------------------------------------------------------
# --omit=dev keeps the pinned openclaw devDependency out of the volume entirely: only the
# file: siblings (@rine-network/core, @rine-network/mcp) are installed, then openclaw@SPEC is
# added with --no-save so package.json's pin is never rewritten. --no-package-lock is required
# on BOTH: the source tree is bind-mounted, so npm would otherwise rewrite the TRACKED
# package-lock.json to whatever floating version this run resolved.
NPM_FLAGS='--no-audit --no-fund --no-package-lock'
oc_own
INSTALL_CMD="npm install --omit=dev $NPM_FLAGS"
[[ "$CANARY_FRESH" == "true" ]] || INSTALL_CMD='true'
INSTALL=$(oc "$INSTALL_CMD && npm install openclaw@$SPEC --no-save $NPM_FLAGS && \
    node -p \"JSON.parse(require('fs').readFileSync('node_modules/openclaw/package.json','utf8')).version\"")
RESOLVED=$(grep -oE '^[0-9]{4}\.[0-9]+\.[0-9]+[A-Za-z0-9.\-]*$' <<<"$INSTALL" | tail -1)
if [[ -z "$RESOLVED" ]]; then
    echo "FATAL: could not install openclaw@$SPEC in the rig"
    tail -15 <<<"$INSTALL"
    exit 2
fi
ok "installed openclaw@$SPEC → $RESOLVED (pinned lane still on $PINNED)"

# ---------------------------------------------------------------------------
echo ""; echo "=== 2 · the REAL openclaw loader loads the plugin ==="
# ---------------------------------------------------------------------------
# A version that rejects the rig's openclaw.json refuses to run `plugins inspect` at all, and
# would otherwise be reported as "the plugin does not load" — a misattribution. Separate the
# two signals first: config-schema drift is upstream news about our fixture, not about the plugin.
VALIDATE=$(oc 'node node_modules/openclaw/openclaw.mjs config validate 2>&1 | head -20')
CONFIG_BAD=$(grep -oE '×.*' <<<"$VALIDATE" | tr '\n' ' ')
if [[ -n "$CONFIG_BAD" ]]; then
    drift "openclaw $RESOLVED rejects rig-e2e/openclaw.json — config-schema drift, NOT a plugin fault" \
          "$CONFIG_BAD"
    echo "         (this version will not run 'plugins inspect' on a config it rejects,"
    echo "          so the loader assertion below cannot be measured)"
fi

# stderr is kept aside rather than discarded: when upstream breaks the loader, its stderr IS
# the actionable part, and mixing it into stdout would corrupt the JSON this stage parses.
SENTINEL="___INSPECT_STDERR___"
INSPECT=$(oc "node node_modules/openclaw/openclaw.mjs plugins inspect rine --runtime --json \
    2>/tmp/oc-inspect.err; echo $SENTINEL; tail -6 /tmp/oc-inspect.err")
INSPECT_JSON=$(sed -n '/^{/,$p' <<<"${INSPECT%%$SENTINEL*}")
INSPECT_ERR=$(grep -vE "^\s*$" <<<"${INSPECT#*$SENTINEL}" | tail -3 | tr '\n' ' ')
STATUS=$(jq -r '.plugin.status // "missing"' <<<"$INSPECT_JSON" 2>/dev/null)
DIAGS=$(jq -r '[.diagnostics[]? | select(.level=="error")] | length' <<<"$INSPECT_JSON" 2>/dev/null)
CHAN=$(jq -r '.plugin.channelIds // [] | join(",")' <<<"$INSPECT_JSON" 2>/dev/null)
if [[ "$STATUS" == "loaded" && "$DIAGS" == "0" ]]; then
    ok "openclaw $RESOLVED loads the plugin (status=$STATUS, 0 error diagnostics)"
    # Only meaningful once the plugin loaded — otherwise it is the same failure reported twice.
    [[ "$CHAN" == *rine* ]] \
        && ok "channel 'rine' still registered by the loader" \
        || drift "channel 'rine' no longer registered" "channelIds=$CHAN"
elif [[ -z "$CONFIG_BAD" ]]; then
    drift "openclaw $RESOLVED does not load the plugin cleanly" \
          "status=${STATUS:-<no json>} errors=${DIAGS:-<no json>} — ${INSPECT_ERR:-(no stderr)}"
fi

# ---------------------------------------------------------------------------
echo ""; echo "=== 3 · tool admission against openclaw $RESOLVED ==="
# ---------------------------------------------------------------------------
# Reuses the E2E's registration harness verbatim: it drives the BUILT dist through the real
# `register()` in "full" mode and records what the plugin offers the loader. Expectations are
# derived from openclaw.plugin.json — the manifest is the single source of truth, and the
# pinned lane (`e2e-onboard.sh`'s "plugin loads with NO identity" section +
# tests/manifest.test.ts) is what pins the manifest itself.
LIST=$(oc "node scripts/e2e-onboard-harness.mjs --list")
LIST_JSON=$(sed -n '/^{/,$p' <<<"$LIST")
REG_ERR=$(jq -r '.registerError // "null"' <<<"$LIST_JSON" 2>/dev/null)
if [[ "$REG_ERR" != "null" ]]; then
    drift "registerFull() threw on openclaw $RESOLVED" "$(head -3 <<<"$REG_ERR" | tr '\n' ' ')"
    echo "         (nothing was registered, so admission is unmeasurable)"
else
    ok "registerFull() runs against openclaw $RESOLVED without throwing"
    MANIFEST_TOOLS=$(jq -c '.contracts.tools | sort' "$PLUGIN_DIR/openclaw.plugin.json")
    MANIFEST_OPT=$(jq -c '[.toolMetadata | to_entries[] | select(.value.optional) | .key] | sort' \
                      "$PLUGIN_DIR/openclaw.plugin.json")
    CODE_TOOLS=$(jq -c '.tools | sort' <<<"$LIST_JSON")
    CODE_OPT=$(jq -c '.optionalTools | sort' <<<"$LIST_JSON")
    [[ "$CODE_TOOLS" == "$MANIFEST_TOOLS" ]] \
        && ok "the offered tool set is unchanged under $RESOLVED ($CODE_TOOLS)" \
        || drift "the offered tool set changed under $RESOLVED" "offered=$CODE_TOOLS manifest=$MANIFEST_TOOLS"
    # OpenClaw withholds an optional plugin tool unless the agent's allowlist names it, and
    # offers every non-optional one under the default empty allowlist. A tool is optional when
    # EITHER gate says so (isPluginToolOptional ORs registerTool's opts and the manifest), so a
    # fresh install can self-onboard only while rine_onboard is free of both.
    if jq -e '(.optionalTools + .manifestOptionalTools) | index("rine_onboard") | not' \
           <<<"$LIST_JSON" >/dev/null 2>&1; then
        ok "rine_onboard stays ungated in code AND manifest — offered under the default allowlist"
    else
        drift "rine_onboard became allowlist-gated" "code=$CODE_OPT manifest=$MANIFEST_OPT"
    fi
    if [[ "$CODE_OPT" == "$MANIFEST_OPT" && \
          "$(jq -c '.manifestOptionalTools | sort' <<<"$LIST_JSON")" == "$MANIFEST_OPT" ]]; then
        ok "the mutating tools stay allowlist-gated in code AND manifest ($MANIFEST_OPT)"
    else
        drift "mutating-tool gating changed" "code=$CODE_OPT manifest=$MANIFEST_OPT"
    fi
fi

# Section 4 lives in its own file (sourced, not executed) so this one stays readable.
source "$SCRIPT_DIR/canary-install.sh"

# ---------------------------------------------------------------------------
echo ""
echo "============================================"
if [[ ${#FAILURES[@]} -eq 0 ]]; then
    echo "  CANARY GREEN — @rine-network/openclaw survives openclaw@$SPEC ($RESOLVED)."
    echo "============================================"
    exit 0
fi
echo "  CANARY RED (ADVISORY) — openclaw@$SPEC resolved to $RESOLVED"
echo ""
echo "  Upstream openclaw $RESOLVED changed under an unchanged plugin. This is NOT a build"
echo "  break: the pinned lane ($PINNED) is unaffected and still gates every release. Triage"
echo "  before changing plugin code — users on '$PEER_RANGE' see this, we do not yet."
echo ""
for f in "${FAILURES[@]}"; do echo "    - $f"; done
echo "============================================"
exit 1
