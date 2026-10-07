#!/usr/bin/env bash
# canary-install.sh — ADVISORY leg that runs the REAL `openclaw plugins install` chain.
#
# WHY THIS EXISTS. Every other rig loads the plugin from source via `plugins.load.paths`,
# which skips openclaw's two install gates: source trust (needs `--force`) and capability
# consent (needs `--accept-capabilities`). So the install command we publish was never
# executed by any lane, and it was broken for every non-TTY user — scripts, containers and
# agents — without a single lane noticing. This leg runs the published command verbatim, and
# the same chain against a locally packed tarball, inside the canary container with no TTY.
#
# ADVISORY, NOT BLOCKING. Like the canary it belongs to, a red leg is upstream news or a
# publish-train fact, not a build break. It is deliberately NOT wired into `scripts/ci.sh`.
#
# ALL OpenClaw execution happens inside the contained rig (compose.openclaw.yml +
# compose.openclaw.canary.yml). openclaw runs from the container's node_modules; nothing
# OpenClaw-related is installed on the host.
#
# Sourced by canary-latest.sh — it reuses COMPOSE, PLUGIN_DIR, PROJECT_ROOT,
# CANARY_STATE_DIR, ok, drift, FAILURES and RESOLVED from the caller.

[[ "${BASH_SOURCE[0]}" != "$0" ]] || { echo "source me from canary-latest.sh"; exit 2; }

OC_BIN="node /work/rine-openclaw/node_modules/openclaw/openclaw.mjs"

# Run a shell command inside the contained rig with NO pseudo-TTY. `-T` is mandatory: without
# it compose allocates a TTY when the caller has one, the install gates PROMPT instead of
# refusing, and the leg stops measuring the no-TTY path it exists to measure. Same noise
# filter as the caller's `oc()`.
oc_notty() { "${COMPOSE[@]}" run --rm -T --entrypoint sh plugin -c "$1" 2>&1 |
             grep -vE '^(\[|Creating|Container |Network |Volume )|npm_config'; }

# One install leg in its own FRESH state dir. $1=leg label, $2=container-side install command.
# The canary's main state dir holds rig-e2e/openclaw.json, which loads `rine` from source via
# `plugins.load.paths`; installing a second `rine` there would collide. So each leg gets a
# fresh dir UNDER the mounted state dir — host $CANARY_STATE_DIR/_install/<leg>/{state,home},
# container /home/node/.openclaw/_install/<leg>/… — which the host can clean up. The dirs are
# created on the host first, so they are owned by the host user, not by root.
run_install_leg() {
    local leg="$1" install_cmd="$2"
    local host="$CANARY_STATE_DIR/_install/$leg"
    mkdir -p "$host/state" "$host/home"
    local out
    out=$(oc_notty "export HOME=/home/node/.openclaw/_install/$leg/home \
OPENCLAW_STATE_DIR=/home/node/.openclaw/_install/$leg/state \
OPENCLAW_CONFIG_PATH=/home/node/.openclaw/_install/$leg/state/openclaw.json; \
$install_cmd; echo __INSTALL_EXIT__=\$?; \
$OC_BIN plugins enable rine; \
$OC_BIN config set plugins.entries.rine.hooks.allowConversationAccess true; echo __OPTIN_EXIT__=\$?; \
$OC_BIN config get plugins.entries.rine.hooks.allowConversationAccess; \
$OC_BIN plugins inspect rine --runtime --json")
    local install_out="${out%%__INSTALL_EXIT__*}"
    local after="${out#*__INSTALL_EXIT__=}"
    local exit_code="${after%%$'\n'*}"
    [[ "$out" == *__INSTALL_EXIT__* ]] || exit_code="missing"
    local optin_exit="missing" optin_get="" status
    if [[ "$after" == *__OPTIN_EXIT__* ]]; then
        local optin_rest="${after#*__OPTIN_EXIT__=}"
        optin_exit="${optin_rest%%$'\n'*}"
        optin_get=$(sed '/^{/,$d' <<<"${optin_rest#*$'\n'}" | grep -x 'true' | head -1)
    fi
    status=$(jq -r '.plugin.status // "missing"' \
        <<<"$(sed -n '/^{/,$p' <<<"${after#*$'\n'}")" 2>/dev/null)
    # Name the gate a refusal came from, so a red leg says which install gate moved.
    local gate=""
    grep -q 'rerun with --force' <<<"$install_out" && gate=" — source-trust gate"
    grep -q 'requires capability consent' <<<"$install_out" && gate=" — capability gate"
    if [[ "$exit_code" == "0" && "$status" == "loaded" && "$optin_exit" == "0" && "$optin_get" == "true" ]]; then
        ok "$leg: install exit 0, opt-in set (config get true), plugins inspect rine → loaded"
    else
        drift "$leg: install exit $exit_code, opt-in exit $optin_exit, config get ${optin_get:-<empty>}, status=${status:-<no json>}$gate" \
              "$(tail -3 <<<"$install_out" | tr '\n' ' ')"
    fi
}

# ---------------------------------------------------------------------------
echo ""; echo "=== 4 · the real install chain, no TTY ==="
# ---------------------------------------------------------------------------

# --- Leg A — the documented command -------------------------------------------------------
# Extract the non-interactive command from the README and run it verbatim, so the command we
# publish is the command this lane executes. It installs the PUBLISHED package from npm.
README_CMD=$(grep -m1 -E '^openclaw plugins install .*--accept-capabilities$' "$PLUGIN_DIR/README.md")
if [[ -z "$README_CMD" ]]; then
    drift "README publishes no non-interactive install command"
else
    CONTAINER_CMD="${OC_BIN}${README_CMD#openclaw}"
    echo "  running: $CONTAINER_CMD"
    run_install_leg "readme" "$CONTAINER_CMD"
fi

# --- Leg B — the local tarball ------------------------------------------------------------
# Pack the working tree the way the publish train does, then install the tarball. The rewrite
# pins the PUBLISHED @rine-network/core / @rine-network/mcp, so while a sibling bump is
# unpublished this leg reads red for a reason that is not an install-gate change.
PACK_DIR="$CANARY_STATE_DIR/_install/pack"
rm -rf "$PACK_DIR"
mkdir -p "$PACK_DIR/rine-openclaw"
for f in package.json openclaw.plugin.json README.md CHANGELOG.md dist skills; do
    cp -R "$PLUGIN_DIR/$f" "$PACK_DIR/rine-openclaw/"
done
# The relative `file:../rine-*` specs must resolve inside the pack dir.
ln -s "$PROJECT_ROOT/rine-core" "$PACK_DIR/rine-core"
ln -s "$PROJECT_ROOT/rine-mcp" "$PACK_DIR/rine-mcp"
if ! REWRITE_ERR=$(python3 "$PROJECT_ROOT/scripts/rewrite-file-deps.py" \
        "$PACK_DIR/rine-openclaw/package.json" 2>&1); then
    echo "FATAL: rewrite-file-deps.py failed on the packed manifest"
    echo "$REWRITE_ERR"
    exit 2
fi
# `npm pack` runs in the container; rine-openclaw/node_modules is never touched and nothing is
# installed on the host.
run_install_leg "tarball" "cd /home/node/.openclaw/_install/pack/rine-openclaw && \
    npm pack --pack-destination .. --ignore-scripts >/dev/null && \
    $OC_BIN plugins install ../rine-network-openclaw-*.tgz --force --accept-capabilities"

# Cleanup: the host `trap … EXIT` in canary-latest.sh removes $WORKDIR, and the state dir
# lives under it, so the per-leg dirs and the pack dir go with it — no extra cleanup here.
