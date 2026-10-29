#!/usr/bin/env bash
# e2e-onboard.sh — FROM-SCRATCH onboarding E2E for the OpenClaw plugin.
#
# Proves a fresh OpenClaw-hosted agent with NO identity can manage its own onboarding
# through the plugin's `rine_onboard` tool, then receive a message — exactly what the
# bundled skill and rine.network/skill-files/openclaw.md instruct an agent to do.
#
# LOCAL-ISOLATED, like every other suite: a throwaway postgres + uvicorn from local source
# on auto-picked ports (scripts/e2e-lib.sh). It NEVER touches production and never reads a
# janitor cred dir — the identity is minted during the run into a fresh empty runtime dir and a
# fresh empty owner dir (root.key + recovery phrase), both under the mktemp WORKDIR outside any checkout.
#
# ALL OpenClaw execution happens inside the contained rig (compose.openclaw.yml +
# compose.openclaw.e2e-onboard.yml). openclaw itself runs from the container's node_modules;
# nothing OpenClaw-related is installed on the host. The host only orchestrates docker, boots
# the server, and drives the rine CLI for the second (peer) identity — the CLI is not OpenClaw.
#
# Run:  bash rine-openclaw/scripts/e2e-onboard.sh
# Prereq: the plugin dist must be built —
#   docker compose -f compose.openclaw.yml run --rm plugin npm install && … npm run build

set -uo pipefail

E2E_NAME="openclaw-onboard"
E2E_BRIDGE=true     # the rig is a bridged container: the server binds the docker bridge gateway
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/e2e-lib.sh"

MX_DOMAIN="${SMOKE_MX_DOMAIN:-gmail.com}"   # server does a live MX lookup at registration
RUN_ID="$RANDOM$RANDOM"
A_SLUG="ocb-$RUN_ID"          # the OpenClaw-hosted agent's org
A_AGENT="assistant"
B_SLUG="ocpeer-$RUN_ID"       # the peer that messages it

export E2E_OC_UID="$(id -u)" E2E_OC_GID="$(id -g)"
export E2E_OC_CREDS_DIR="$WORKDIR/oc-rine"     # FRESH + EMPTY: the whole point of the test
export E2E_OC_STATE_DIR="$WORKDIR/oc-state"
# The rig uses the origin the server was started with (the docker bridge gateway): a token
# assertion is signed for that origin, and any other hostname fails the audience check.
export RINE_API_URL="$API_URL"
mkdir -p "$E2E_OC_CREDS_DIR" "$E2E_OC_STATE_DIR"
# The org root and recovery phrase go in an owner dir apart from the runtime dir. It is the
# sibling `<runtime dir>.owner`, the path $CLI derives for the same RINE_CONFIG_DIR, so the
# host-side `get_token` below reads the identity the container minted. The compose override
# mounts it at /home/node/.rine-owner and points RINE_OWNER_DIR there.
export E2E_OC_OWNER_DIR="$(org_owner_dir "$E2E_OC_CREDS_DIR")"
cp "$PROJECT_ROOT/rine-openclaw/rig-e2e/openclaw.json" "$E2E_OC_STATE_DIR/openclaw.json"

COMPOSE=(docker compose -f "$PROJECT_ROOT/compose.openclaw.yml"
         -f "$PROJECT_ROOT/compose.openclaw.e2e-onboard.yml")

# Real-gateway stages (the actual `openclaw gateway` process, contained).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e-onboard-gateway.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/phrase-leak.sh"

# Run a shell command inside the contained rig; strips compose's own chatter.
oc() { "${COMPOSE[@]}" run --rm --entrypoint sh plugin -c "$1" 2>&1 |
       grep -vE '^(\[|Creating|Container |Network |Volume )|npm_config'; }
# Run the tool harness; echoes everything, callers grep RESULT_JSON.
harness() { oc "node scripts/e2e-onboard-harness.mjs $1"; }
json_of() { grep -o 'RESULT_JSON:.*' | sed 's/^RESULT_JSON://'; }

# ---------------------------------------------------------------------------
section "1 · rig reaches the throwaway server"
# ---------------------------------------------------------------------------

CONN=$(oc 'node -e "fetch(process.env.RINE_API_URL+\"/health\").then(r=>r.status).then(s=>console.log(\"HEALTH_STATUS:\"+s)).catch(e=>console.log(\"CONN_ERR:\"+e.message))"')
if grep -q "HEALTH_STATUS:200" <<<"$CONN"; then
    pass "container reaches host server at $RINE_API_URL"
else
    fail "container cannot reach $RINE_API_URL" "$(tail -3 <<<"$CONN")"
    echo "  Aborting: without connectivity nothing else is meaningful."; e2e_summary
fi

# The rig must hand the container an owner dir. Without one the root key and phrase land in the
# container's own home, die with the one-shot container, and the next `oc` call finds no org.
if [[ "$(oc 'test -d "$RINE_OWNER_DIR" && echo OWNER_DIR_OK')" == *OWNER_DIR_OK* ]]; then
    pass "rig mounts the owner dir at RINE_OWNER_DIR (root.key and phrase survive between calls)"
else
    fail "rig has no RINE_OWNER_DIR mount" "compose.openclaw.e2e-onboard.yml must mount E2E_OC_OWNER_DIR and set RINE_OWNER_DIR"
    echo "  Aborting: onboarding cannot persist its org root."; e2e_summary
fi

# ---------------------------------------------------------------------------
section "2 · plugin loads with NO identity (pre-onboarding UX)"
# ---------------------------------------------------------------------------

INSPECT=$(oc 'node node_modules/openclaw/openclaw.mjs plugins inspect rine --runtime --json 2>/dev/null')
INSPECT_JSON=$(sed -n '/^{/,$p' <<<"$INSPECT")
STATUS=$(jq -r '.plugin.status // "missing"' <<<"$INSPECT_JSON" 2>/dev/null)
DIAGS=$(jq -r '[.diagnostics[]? | select(.level=="error")] | length' <<<"$INSPECT_JSON" 2>/dev/null)
CHAN=$(jq -r '.plugin.channelIds // [] | join(",")' <<<"$INSPECT_JSON" 2>/dev/null)
[[ "$STATUS" == "loaded" && "$DIAGS" == "0" ]] \
    && pass "openclaw loader loads the plugin with no identity (status=$STATUS, 0 error diagnostics)" \
    || fail "openclaw loader did not load the plugin cleanly" "status=$STATUS errors=$DIAGS"
[[ "$CHAN" == *rine* ]] && pass "channel 'rine' registered pre-onboarding" \
    || fail "channel 'rine' not registered" "channelIds=$CHAN"

LIST=$(harness "--list --probe-service")
LIST_JSON=$(sed -n '/^{/,$p' <<<"$LIST")
REG_ERR=$(jq -r '.registerError // "null"' <<<"$LIST_JSON" 2>/dev/null)
[[ "$REG_ERR" == "null" ]] \
    && pass "registerFull() does not throw without an identity" \
    || fail "registerFull() threw pre-onboarding" "$REG_ERR"
jq -e '.tools | index("rine_onboard")' <<<"$LIST_JSON" >/dev/null 2>&1 \
    && pass "rine_onboard is registered by the plugin with no identity" \
    || fail "rine_onboard NOT registered pre-onboarding" "tools=$(jq -c '.tools' <<<"$LIST_JSON")"
# Registering the tool is not the same as a model being offered it. OpenClaw withholds an
# optional plugin tool unless the agent's tool allowlist names it ('*', 'group:plugins',
# 'rine', or the tool name) and offers every non-optional one under the default EMPTY
# allowlist (tools-*.js allowlistIncludesDefaultPluginTools). A tool counts as optional when
# EITHER the registerTool call or the manifest's toolMetadata says so (isPluginToolOptional
# ORs them), so both gates are asserted: rine_onboard must be free of both — a fresh install
# self-onboards with no human config edit — while the mutating tools keep both.
MANIFEST_OPT=$(jq -c '.manifestOptionalTools' <<<"$LIST_JSON" 2>/dev/null)
CODE_OPT=$(jq -c '.optionalTools' <<<"$LIST_JSON" 2>/dev/null)
if jq -e '(.optionalTools + .manifestOptionalTools) | index("rine_onboard") | not' \
       <<<"$LIST_JSON" >/dev/null 2>&1; then
    pass "rine_onboard is ungated in code AND manifest — offered under the default allowlist"
else
    fail "rine_onboard is optional-gated again" "code=$CODE_OPT manifest=$MANIFEST_OPT"
fi
EXPECT_OPT='["rine_fulfill","rine_group_invite","rine_group_reclaim","rine_group_remove","rine_group_vote","rine_pay","rine_send","rine_send_and_wait"]'
if [[ "$(jq -c '.optionalTools | sort' <<<"$LIST_JSON")" == "$EXPECT_OPT" &&
      "$(jq -c '.manifestOptionalTools | sort' <<<"$LIST_JSON")" == "$EXPECT_OPT" ]]; then
    pass "the eight third-party-effect tools stay allowlist-gated in code AND manifest"
else
    fail "mutating-tool gating changed" "code=$CODE_OPT manifest=$MANIFEST_OPT"
fi
# The rest of the group surface must be on the other side of the line: a default install
# has to be able to create, discover, join and read a group without an allowlist edit, and
# a leave acts only on this host. Inviting is NOT on that side — it acts on the group's
# roster on membership alone. Asserted against BOTH gates, since OpenClaw ORs them.
UNGATED_GROUP='["rine_discover_groups","rine_group_create","rine_group_inspect","rine_group_invites","rine_group_join","rine_group_leave","rine_group_requests","rine_group_roster","rine_group_sync","rine_groups"]'
if [[ "$(jq -c '[.tools[] | select(startswith("rine_group") or . == "rine_discover_groups")]
                | map(select(. as $t | ["rine_group_invite","rine_group_reclaim","rine_group_remove","rine_group_vote"] | index($t) | not))
                | sort' <<<"$LIST_JSON")" == "$UNGATED_GROUP" ]] &&
   jq -e --argjson want "$UNGATED_GROUP" \
        '[(.optionalTools + .manifestOptionalTools)[] | select(. as $t | $want | index($t))] | length == 0' \
        <<<"$LIST_JSON" >/dev/null 2>&1; then
    pass "the other ten group tools are registered and ungated in code AND manifest"
else
    fail "the default-install group surface changed" \
         "tools=$(jq -c '.tools' <<<"$LIST_JSON") code=$CODE_OPT manifest=$MANIFEST_OPT"
fi
[[ "$(jq -r '.identityPresent' <<<"$LIST_JSON" 2>/dev/null)" == "false" ]] \
    && pass "runtime and owner dirs start with no identity (a genuine from-scratch run)" \
    || fail "an identity existed at start" "$(jq -c '.identity' <<<"$LIST_JSON")"
echo "  pre-onboarding service log: $(jq -r '[.logs[]? | select(test("identity|idle"))] | first // "(none)"' <<<"$LIST_JSON" 2>/dev/null)"
echo "  channels.rine in effect:    $(jq -c '.channelConfig' <<<"$LIST_JSON" 2>/dev/null)"

section "2b · the REAL openclaw gateway boots on a never-onboarded install"
gateway_stage_no_identity

# ---------------------------------------------------------------------------
section "3 · the agent onboards itself via rine_onboard (PoW ~30-60s)"
# ---------------------------------------------------------------------------

ONB_ARGS=$(jq -nc --arg e "$A_SLUG@$MX_DOMAIN" --arg n "OpenClaw E2E $RUN_ID" \
                  --arg s "$A_SLUG" --arg a "$A_AGENT" \
                  '{email:$e, org_name:$n, org_slug:$s, agent_name:$a}')
ONB_OUT=$(harness "rine_onboard '$ONB_ARGS'")
ONB_JSON=$(json_of <<<"$ONB_OUT")
if [[ "$(jq -r '.status // ""' <<<"$ONB_JSON" 2>/dev/null)" == "registered" ]]; then
    pass "rine_onboard returned status=registered"
else
    fail "rine_onboard did not register" "$(tail -6 <<<"$ONB_OUT")"
fi
A_HANDLE=$(jq -r '.agent.handle // ""' <<<"$ONB_JSON" 2>/dev/null)
A_AGENT_ID=$(jq -r '.agent.id // ""' <<<"$ONB_JSON" 2>/dev/null)
[[ -n "$A_HANDLE" ]] && pass "onboard returned a handle ($A_HANDLE)" \
    || fail "onboard returned no handle" "$(head -c 400 <<<"$ONB_JSON")"

# ---------------------------------------------------------------------------
section "4 · org root, keys, identity, and server-side registration"
# ---------------------------------------------------------------------------

# The org root and the recovery phrase live in the owner dir, never the runtime dir, and the
# retired client_secret sign-in file is written nowhere.
[[ -f "$E2E_OC_OWNER_DIR/root.key" && -f "$E2E_OC_OWNER_DIR/recovery-phrase.txt" ]] \
    && pass "root.key and recovery-phrase.txt written into the fresh owner dir" \
    || fail "no org root in $E2E_OC_OWNER_DIR" "$(ls -A "$E2E_OC_OWNER_DIR" 2>/dev/null | tr '\n' ' ')"
[[ "$(stat -c %a "$E2E_OC_OWNER_DIR/root.key" 2>/dev/null)" == "600" ]] \
    && pass "root.key is mode 0600" \
    || fail "root.key is not mode 0600" "$(stat -c %a "$E2E_OC_OWNER_DIR/root.key" 2>/dev/null)"
[[ ! -e "$E2E_OC_CREDS_DIR/credentials.json" && ! -e "$E2E_OC_OWNER_DIR/credentials.json" ]] \
    && pass "no credentials.json is written anywhere (no client_secret sign-in)" \
    || fail "the retired credentials.json was written" "$(ls -A "$E2E_OC_CREDS_DIR" "$E2E_OC_OWNER_DIR" 2>/dev/null | tr '\n' ' ')"
[[ ! -e "$E2E_OC_CREDS_DIR/root.key" && ! -e "$E2E_OC_CREDS_DIR/recovery-phrase.txt" ]] \
    && pass "the runtime dir holds no org root and no phrase file" \
    || fail "org root material leaked into the runtime dir" "$(ls -A "$E2E_OC_CREDS_DIR" 2>/dev/null | tr '\n' ' ')"
[[ -f "$E2E_OC_CREDS_DIR/profiles.json" ]] \
    && pass "profiles.json written into the fresh runtime dir" \
    || fail "no profiles.json in $E2E_OC_CREDS_DIR" "$(ls -A "$E2E_OC_CREDS_DIR" 2>/dev/null | tr '\n' ' ')"
# The tool result names the phrase file and never carries its words: the model that called
# rine_onboard must not be handed the phrase. Pass/fail text never prints the phrase itself.
[[ "$(jq -r '.recovery_phrase_file // ""' <<<"$ONB_JSON" 2>/dev/null)" == */recovery-phrase.txt ]] \
    && pass "rine_onboard returned recovery_phrase_file (a path)" \
    || fail "rine_onboard returned no recovery_phrase_file" "$(jq -c 'keys' <<<"$ONB_JSON" 2>/dev/null)"
PHRASE="$(cat "$E2E_OC_OWNER_DIR/recovery-phrase.txt" 2>/dev/null)"
if [[ -n "$PHRASE" ]] && ! leaks_phrase_words "$E2E_OC_OWNER_DIR/recovery-phrase.txt" <<<"$ONB_OUT"; then
    pass "the rine_onboard output never carries the recovery phrase"
else
    fail "the recovery phrase reached the rine_onboard output, or no phrase file exists" "(phrase withheld)"
fi
unset PHRASE
KEYFILES=$(find "$E2E_OC_CREDS_DIR" -name '*.key' 2>/dev/null | wc -l)
[[ "$KEYFILES" -gt 0 ]] \
    && pass "E2EE key material written ($KEYFILES *.key files)" \
    || fail "no *.key files written" "dir: $(ls -AR "$E2E_OC_CREDS_DIR" 2>/dev/null | head -5 | tr '\n' ' ')"

WHO_JSON=$(harness "rine_whoami '{}'" | json_of)
[[ "$(jq -r '.org.slug // ""' <<<"$WHO_JSON" 2>/dev/null)" == "$A_SLUG" ]] \
    && pass "rine_whoami reports the new org ($A_SLUG)" \
    || fail "rine_whoami did not report the new org" "$(head -c 300 <<<"$WHO_JSON")"
[[ "$(jq -r '[.agents[]? | select(.has_keys==true)] | length' <<<"$WHO_JSON" 2>/dev/null)" -ge 1 ]] \
    && pass "rine_whoami confirms local keys present for the agent" \
    || fail "rine_whoami reports no local keys" "$(jq -c '[.agents[]?|{handle,has_keys}]' <<<"$WHO_JSON" 2>/dev/null)"

# Independent server-side proof: sign in as the minted org through the CLI and ask the API.
A_TOKEN=$(get_token "$E2E_OC_CREDS_DIR")
SRV_AGENTS=$(api_get "$A_TOKEN" "$API_URL/agents" 2>/dev/null)
[[ "$(jq -r --arg id "$A_AGENT_ID" '[.items[]? | select(.id==$id)] | length' <<<"$SRV_AGENTS" 2>/dev/null)" == "1" ]] \
    && pass "server-side: GET /agents lists the onboarded agent ($A_AGENT_ID)" \
    || fail "server does not list the onboarded agent" "$(head -c 300 <<<"$SRV_AGENTS")"

# ---------------------------------------------------------------------------
section "5 · roundtrip: a peer messages the OpenClaw agent"
# ---------------------------------------------------------------------------

B_DIR="$WORKDIR/peer"; mkdir -p "$B_DIR"
MARKER="hello-openclaw-$RUN_ID"
if RINE_API_URL="$API_URL" RINE_CONFIG_DIR="$B_DIR" $CLI onboard \
        --email "$B_SLUG@$MX_DOMAIN" --name "Peer $RUN_ID" --slug "$B_SLUG" --agent-name peer \
        > "$WORKDIR/peer-onboard.log" 2>&1; then
    pass "peer identity onboarded on the host via the CLI"
else
    fail "peer onboarding failed" "$(tail -4 "$WORKDIR/peer-onboard.log")"
fi
if RINE_API_URL="$API_URL" RINE_CONFIG_DIR="$B_DIR" $CLI send \
        --to "$A_HANDLE" --payload "{\"task\":\"$MARKER\"}" \
        > "$WORKDIR/peer-send.log" 2>&1; then
    pass "peer sent an encrypted message to $A_HANDLE"
else
    fail "peer send failed" "$(tail -4 "$WORKDIR/peer-send.log")"
fi

INBOX_JSON=$(harness "rine_inbox '{}'" | json_of)
if grep -q "$MARKER" <<<"$INBOX_JSON"; then
    pass "the plugin's rine_inbox sees and DECRYPTS the peer's message"
else
    fail "plugin inbox did not surface the peer message" "$(head -c 400 <<<"$INBOX_JSON")"
fi

section "5b · the rine CHANNEL wakes the gateway over SSE"
gateway_stage_sse_roundtrip

# ---------------------------------------------------------------------------
section "6 · the freshly-onboarded agent runs a group through the plugin"
# ---------------------------------------------------------------------------
# Registration is not execution: a group ToolDef can be registered and still throw
# through the plugin adapter. These invoke the real handlers against the throwaway
# server, on the identity minted in section 3 and nothing else.

G_NAME="oc-grp-$RUN_ID"
GC_ARGS=$(jq -nc --arg n "$G_NAME" '{name:$n, visibility:"private", enrollment:"majority"}')
GC_JSON=$(harness "rine_group_create '$GC_ARGS'" | json_of)
G_ID=$(jq -r '.id // ""' <<<"$GC_JSON" 2>/dev/null)
if [[ -n "$G_ID" && "$(jq -r '.enrollment_policy // ""' <<<"$GC_JSON")" == "majority" ]]; then
    pass "rine_group_create founded a majority group ($G_NAME)"
else
    fail "rine_group_create did not create the group" "$(head -c 400 <<<"$GC_JSON")"
fi

GL_JSON=$(harness "rine_groups '{}'" | json_of)
jq -e --arg id "$G_ID" '[.items[]? | select(.id==$id)] | length == 1' <<<"$GL_JSON" >/dev/null 2>&1 \
    && pass "rine_groups lists the group the agent just made" \
    || fail "rine_groups does not list the new group" "$(head -c 400 <<<"$GL_JSON")"

GM_JSON=$(harness "rine_group_roster '{\"group_id\":\"$G_ID\"}'" | json_of)
[[ "$(jq -r --arg id "$A_AGENT_ID" '[.items[]? | select(.agent_id==$id)] | length' <<<"$GM_JSON" 2>/dev/null)" == "1" ]] \
    && pass "rine_group_roster shows the creator on the roster" \
    || fail "rine_group_roster does not show the creator" "$(head -c 400 <<<"$GM_JSON")"

# `pending` is the vote queue rine_group_vote acts on; nobody has applied yet.
GR_JSON=$(harness "rine_group_requests '{\"group_id\":\"$G_ID\"}'" | json_of)
[[ "$(jq -r '.total // "x"' <<<"$GR_JSON" 2>/dev/null)" == "0" ]] \
    && pass "rine_group_requests answers with an empty vote queue" \
    || fail "rine_group_requests did not answer" "$(head -c 400 <<<"$GR_JSON")"

# Somebody else's group, so the plugin exercises the join/leave path a member really
# walks: the creator is a group's last admin and the server refuses to remove one.
PEER_G="ocpeer-grp-$RUN_ID"
if RINE_API_URL="$API_URL" RINE_CONFIG_DIR="$B_DIR" $CLI group create \
        --name "$PEER_G" --enrollment open --visibility public \
        > "$WORKDIR/peer-group.log" 2>&1; then
    pass "peer created an open, public group on the host via the CLI"
else
    fail "peer group creation failed" "$(tail -4 "$WORKDIR/peer-group.log")"
fi

DISC_JSON=$(harness "rine_discover_groups '{\"query\":\"$PEER_G\"}'" | json_of)
PEER_G_ID=$(jq -r --arg n "$PEER_G" 'first(.items[]? | select(.name==$n) | .id) // ""' <<<"$DISC_JSON" 2>/dev/null)
[[ -n "$PEER_G_ID" ]] \
    && pass "rine_discover_groups finds the peer's public group" \
    || fail "rine_discover_groups did not find the peer's group" "$(head -c 400 <<<"$DISC_JSON")"

GJ_JSON=$(harness "rine_group_join '{\"group_id\":\"$PEER_G_ID\"}'" | json_of)
grep -q '"error"' <<<"$GJ_JSON" \
    && fail "rine_group_join failed" "$(head -c 400 <<<"$GJ_JSON")" \
    || pass "rine_group_join joins the peer's open group"

# An open group runs Sender Keys and has no epoch chain, so sync does not walk one:
# it installs the sender keys waiting in this agent's own inbox and posts nothing.
#
# 🔴 Assert the BEHAVIOUR, never the noun. This gate used to be `grep -qi "sender key"`,
# which every success render satisfies too — so it passed whether the verb recovered the
# group or refused it, while its own pass line claimed the refusal. The fields are the
# behaviour: which recovery ran, that this agent's material was not retired, and a count
# of what was installed. `| tostring` because `// empty` renders a legitimate `false` as
# an empty string, which reads as a missing field.
GS_JSON=$(harness "rine_group_sync '{\"group_id\":\"$PEER_G_ID\"}'" | json_of)
GS_REGIME=$(jq -r '.regime // ""' <<<"$GS_JSON" 2>/dev/null)
GS_RETIRED=$(jq -r '.retired | tostring' <<<"$GS_JSON" 2>/dev/null)
GS_INGESTED=$(jq -r '.ingested | tostring' <<<"$GS_JSON" 2>/dev/null)
if [[ "$GS_REGIME" == "sender-key" && "$GS_RETIRED" == "false" && "$GS_INGESTED" =~ ^[0-9]+$ ]] \
   && ! grep -q "There is nothing to sync here" <<<"$GS_JSON"; then
    pass "rine_group_sync recovers a sender-key group (installed $GS_INGESTED key(s))"
else
    fail "rine_group_sync did not recover the open group" "$(head -c 400 <<<"$GS_JSON")"
fi

# A leave is the one irreversible group verb offered under the default allowlist.
GLV_JSON=$(harness "rine_group_leave '{\"group_id\":\"$PEER_G_ID\"}'" | json_of)
[[ "$(jq -r '.left // "x"' <<<"$GLV_JSON" 2>/dev/null)" == "true" ]] \
    && pass "rine_group_leave takes the agent out of the peer's group" \
    || fail "rine_group_leave failed" "$(head -c 400 <<<"$GLV_JSON")"

e2e_summary
