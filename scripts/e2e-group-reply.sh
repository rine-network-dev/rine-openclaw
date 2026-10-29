#!/usr/bin/env bash
# e2e-group-reply.sh — ADVISORY, CREDENTIAL-GATED wire test of the plugin's OUTBOUND path.
#
# WHY THIS EXISTS. The plugin's standing rule is that behaviour is proven in Docker, and 187
# in-Docker unit tests still could not catch the group-answer defect: `reply-routing.test.ts`,
# `dispatch-seam.test.ts` and `outbound-send.test.ts` all mock `../src/outbound.js` or
# `@rine-network/mcp/tools`, so no test executes openclaw → mcp → the wire in one process. That
# mock is what hid an agent answering a group into the void for a month. This lane closes the
# gap by running the real gateway against a real server and reading the answer out of the
# database.
#
# Question: when a rine GROUP post reaches an OpenClaw-hosted agent, what does the plugin
# actually do on the OUTBOUND path? Does the group hear the reply? Does anything error?
# If a message is created, who receives it and in what conversation?
#
# Design: three arms against the SAME server. The first two share one running gateway, so
# the only variable between them is group-ness.
#   ARM 1 (control)    — peer B sends a 1:1 DM to A. Reply expected to land.
#   ARM 2 (experiment) — peer B posts to an open group A is a member of.
#   ARM 3 (attribution)— scripted curl, after the gateway stops: which of org A's agents a
#                        reply comes FROM, who may reply at all, and whose unread state a
#                        read burns.
#
# WHY ORG A HOLDS TWO AGENTS. `ops` acts; `assistant` exists and never acts. With one agent
# the server auto-selects it and every acting-agent behaviour collapses to the prior one —
# a green run then proves nothing about the behaviour that changed them. The second agent
# is what makes `X-Rine-Agent` decide anything here.
#
# And it is what gives ARM 1 a question worth asking. The reply the model causes is
# ATTRIBUTED to one agent by the server and SEALED with an agent's key by the client; those
# are two different derivations of the same identity, and a disagreement is SILENT — both
# sides report success and the counterparty gets `sender-mismatch` with the plaintext
# withheld (`rine-core/src/crypto/agent-keys.ts`). No scripted client can fake the path that
# produces it, so ARM 1 ends by making peer B actually DECRYPT the reply.
#
# Ground truth is read from the throwaway postgres directly — every `messages` row, with
# from/to/group/conversation — so "who received it" is measured, not inferred.
#
# ADVISORY AND CREDENTIAL-GATED, deliberately NOT in `ci.sh` or the pre-push hook — the same
# posture as `canary-latest.sh`. It needs a MODEL PROVIDER, which no shipped rig has: without an
# agent turn `deliver()` never fires and the plugin's outbound path never executes at all
# (`e2e-onboard-gateway.sh` says so in its own words). It reads `TOGETHER_API_KEY` from the
# repo-root `.env.e2e`, spends real tokens against a third-party API, and takes minutes.
#
# LOCAL-ISOLATED otherwise: a throwaway postgres + uvicorn from local source on auto-picked
# ports (`scripts/e2e-lib.sh`). It never touches production and never reads a janitor cred dir.
# ALL OpenClaw execution is inside the contained rig. Nothing is installed on the host.
#
# Run:  bash rine-openclaw/scripts/e2e-group-reply.sh
# Prereq: the plugin dist must be built —
#   docker compose -f compose.openclaw.yml run --rm plugin npm install && … npm run build
#
# Exit: 0 = every assertion held · 1 = an assertion failed · 2 = credentials absent.

set -uo pipefail

E2E_NAME="openclaw-groupreply"

# The credential gate, BEFORE the rig is stood up: a missing key must cost nothing and must not
# read as a pass. Checked here rather than after sourcing e2e-lib.sh, which boots postgres.
_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ ! -r "$_repo_root/.env.e2e" ]]; then
    echo "SKIPPED: $_repo_root/.env.e2e is missing or unreadable." >&2
    echo "  This lane needs a model provider — see the header. Nothing was started." >&2
    exit 2
fi
# 🔴 `set -a` makes this source OVERWRITE an exported RINE_E2E_* variable, so anything chosen
# per run in the environment would be silently replaced by the file's — and .env.e2e is the
# shared credential file, never a per-run knob: nothing here edits it, so model and endpoint
# selection has to survive this source. That is not a hypothetical: capturing only
# RINE_E2E_MODEL left the endpoint un-overridable, and a run exported with a deliberately
# broken base URL went to the file's real one — which is how the first mutation-proof arm for
# the model gate below came back RED for the WRONG reason (a genuine provider HTTP 500 at the
# real endpoint), exactly the "a stale expectation and a real defect fail identically" shape.
#
# So the capture is GENERAL, not a list of the keys someone remembered: every RINE_E2E_* name
# already exported is snapshotted and restored around the source. A fourth steerable key added
# to `.env.e2e` later cannot re-arm the trap, because nothing here has to be told about it.
# 🔴 Never `declare -p $(compgen -v | grep …)` in one breath: with no match the substitution
# is EMPTY and `declare -p` with no arguments dumps EVERY shell variable, which the restore
# below would then eval back over the sourced file. The name list is collected first and the
# whole restore is skipped when it is empty.
_caller_env=""
_caller_names=$(compgen -v | grep '^RINE_E2E_' || true)
# `declare -p` of an exported variable is `declare -x NAME="value"`; eval'ing it back after
# the source puts the caller's value on top of the file's. Only variables reaching this
# script from the ENVIRONMENT can be seen here at all, so this is exactly the set of keys a
# caller steered the run with.
[[ -z "$_caller_names" ]] || _caller_env=$(declare -p $_caller_names 2>/dev/null)
set -a; source "$_repo_root/.env.e2e"; set +a
[[ -z "$_caller_env" ]] || eval "$_caller_env"
if [[ -z "${TOGETHER_API_KEY:-}" ]]; then
    echo "SKIPPED: .env.e2e carries no TOGETHER_API_KEY. Nothing was started." >&2
    exit 2
fi

E2E_BRIDGE=true     # the rig is a bridged container: the server binds the docker bridge gateway
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/e2e-lib.sh"

MX_DOMAIN="${SMOKE_MX_DOMAIN:-gmail.com}"
RUN_ID="$RANDOM$RANDOM"
A_SLUG="ocg-$RUN_ID"      # the OpenClaw-hosted agent's org
B_SLUG="ocgp-$RUN_ID"     # the peer that messages it
MODEL="together/${RINE_E2E_MODEL:-meta-llama/Llama-3.3-70B-Instruct-Turbo}"
MODEL_ID="${MODEL#together/}"
# 🔴 The model ENTRY, not just the ref. openclaw 2026.9.1 ships a fixed Together catalogue and
# refuses anything outside it — `Unknown model: together/<id>`, per lane, on stdout — and this
# suite then scores 28/0 GREEN because every assertion it makes is satisfied by the error text
# openclaw sends as the reply ("⚠️ The configured model is unavailable from the provider").
# Measured on 2026-09-04 with zai-org/GLM-5.3-Flash. A declared entry MERGES with the catalogue
# (the built-ins stay listed), so this costs the default model nothing: 131072 is what the
# catalogue already reports for Llama-3.3-70B-Instruct-Turbo. Override for a model of another
# size — a contextWindow larger than the provider serves comes back as a 400 the host reports
# as a context overflow.
MODEL_CTX="${RINE_E2E_CTX:-131072}"
# 🔴 Validated, because it is the ONE unquoted interpolation in the config heredoc below.
# A non-numeric value ("131k", a stray space, a deliberately-exported empty string) produces
# `"contextWindow": 131k` — invalid JSON, which openclaw refuses, so the gateway never
# reaches its notify line and this suite fails at "notify service never started": a message
# that reads as a product regression on the host this phase just moved to.
[[ "$MODEL_CTX" =~ ^[0-9]+$ ]] || {
    echo "SKIPPED: RINE_E2E_CTX must be a positive integer; got [$MODEL_CTX]. Nothing was started." >&2
    exit 2
}
# 🔴 And the baseUrl WITH it. A `models` array turns the built-in `together` into a
# config-defined provider, which 2026.9.1 then refuses to call without an endpoint of its own:
#   rawError=Provider "together" requires an explicit base URL before using an OpenAI-compatible API.
# The suite scores 28/0 through that too — the refusal arrives as the agent's reply text.
MODEL_BASE_URL="${RINE_E2E_BASE_URL:-https://api.together.xyz/v1}"
A_ACTOR="ops"             # org A's ACTING agent: the gateway binds to it, B addresses it
A_IDLE="assistant"        # the sibling that never acts — what makes the org multi-agent

export E2E_OC_UID="$(id -u)" E2E_OC_GID="$(id -g)"
export E2E_OC_CREDS_DIR="$WORKDIR/oc-rine"
export E2E_OC_STATE_DIR="$WORKDIR/oc-state"
# The plugin is agent-only and never reads an owner dir, but the rig's bind must name one that
# exists. An empty dir keeps org A's real owner dir (root key, phrase) out of the container.
export E2E_OC_OWNER_DIR="$WORKDIR/oc-owner-empty"
# Bridged rig: same origin the server was started with, so token assertions match.
export RINE_API_URL="$API_URL"
mkdir -p "$E2E_OC_CREDS_DIR" "$E2E_OC_STATE_DIR" "$E2E_OC_OWNER_DIR"

# `agentId` is load-bearing, not decoration. Org A holds two agents, so the notify service's
# own resolve (`resolveBoundAgentId`) has no single-agent shortcut left and the service would
# idle without it — and the same setting is what binds every EXPOSED tool call the model makes
# to `ops` (`withActingAgent`). The INTERNAL `rine_reply` behind the auto-answer is deliberately
# not wrapped: it derives its actor from the message it is answering, which is the derivation
# ARM 1 exists to check.
cat > "$E2E_OC_STATE_DIR/openclaw.json" <<JSON
{
  "meta": { "lastTouchedVersion": "2026.9.1" },
  "gateway": { "mode": "local", "bind": "loopback", "auth": { "mode": "none" } },
  "agents": { "defaults": { "model": { "primary": "$MODEL" } }, "entries": { "default": {} } },
  "models": { "providers": { "together": { "baseUrl": "$MODEL_BASE_URL", "models": [
    { "id": "$MODEL_ID", "name": "$MODEL_ID", "contextWindow": $MODEL_CTX, "maxTokens": 8192 } ] } } },
  "channels": {
    "rine": { "transport": "sse", "agentId": "$A_ACTOR", "allowFrom": ["*"], "healthMonitor": { "enabled": false } }
  },
  "plugins": {
    "entries": { "rine": { "enabled": true, "hooks": { "allowConversationAccess": true } } },
    "load": { "paths": ["/work/rine-openclaw"] }
  }
}
JSON

COMPOSE=(docker compose -f "$PROJECT_ROOT/compose.openclaw.yml"
         -f "$PROJECT_ROOT/compose.openclaw.e2e-onboard.yml"
         -f "$PROJECT_ROOT/compose.openclaw.together.yml"
         -f "$PROJECT_ROOT/rine-openclaw/scripts/compose.openclaw.group-reply.yml")

source "$(dirname "${BASH_SOURCE[0]}")/e2e-group-reply-lib.sh"
# ---------------------------------------------------------------------------
section "1 · identities and an open group A belongs to"
# ---------------------------------------------------------------------------

A_DIR="$E2E_OC_CREDS_DIR"; B_DIR="$WORKDIR/peer"; IDLE_DIR="$WORKDIR/idle"; mkdir -p "$B_DIR" "$IDLE_DIR"
rine_a() { RINE_API_URL="$API_URL" RINE_CONFIG_DIR="$A_DIR" $CLI "$@"; }
rine_b() { RINE_API_URL="$API_URL" RINE_CONFIG_DIR="$B_DIR" $CLI "$@"; }

# The onboarded agent IS the acting one: it takes the runtime dir's default profile, which is the
# identity the agent-only plugin signs as, so `agentId: ops` below names the principal it holds.
rine_a onboard --email "$A_SLUG@$MX_DOMAIN" --name "OC group $RUN_ID" --slug "$A_SLUG" \
       --agent-name "$A_ACTOR" > "$WORKDIR/a-onboard.log" 2>&1 \
    && pass "OpenClaw agent A ($A_ACTOR) onboarded into the rig's bind-mounted config dir" \
    || fail "A onboarding failed" "$(tail -4 "$WORKDIR/a-onboard.log")"
rine_b onboard --email "$B_SLUG@$MX_DOMAIN" --name "Peer $RUN_ID" --slug "$B_SLUG" \
       --agent-name peer > "$WORKDIR/b-onboard.log" 2>&1 \
    && pass "peer B onboarded" \
    || fail "B onboarding failed" "$(tail -4 "$WORKDIR/b-onboard.log")"

A_TOKEN=$(get_token "$A_DIR"); B_TOKEN=$(get_token "$B_DIR")

# The idle sibling is minted by the owner into a runtime dir of its own, so the gateway's dir
# holds only the acting agent's keys. The org still has two agents, which is what makes the
# acting-agent assertions in ARM 3 say something.
RINE_API_URL="$API_URL" RINE_CONFIG_DIR="$IDLE_DIR" RINE_OWNER_DIR="$(org_owner_path "$A_DIR")" \
    $CLI agent create --name "$A_IDLE" > "$WORKDIR/a-idle.log" 2>&1 \
    && pass "the owner minted a second agent ($A_IDLE) into its own runtime dir — the single-agent shortcut is gone" \
    || fail "creating $A_IDLE failed" "$(tail -4 "$WORKDIR/a-idle.log")"

# By NAME, never `.items[0]`: with two agents the list order decides which identity every
# later assertion is about. `A_AGENT_ID`/`A_HANDLE` stay the ACTING agent, so every existing
# "rows from A" query keeps meaning what it meant.
A_AGENTS=$(api_get "$A_TOKEN" "$API_URL/agents")
a_field() { jq -r --arg n "$1" --arg f "$2" '.items[] | select(.name==$n) | .[$f] // empty' <<<"$A_AGENTS"; }
A_AGENT_ID=$(a_field "$A_ACTOR" id);  A_HANDLE=$(a_field "$A_ACTOR" handle)
IDLE_ID=$(a_field "$A_IDLE" id);      IDLE_HANDLE=$(a_field "$A_IDLE" handle)
B_AGENT_ID=$(api_get "$B_TOKEN" "$API_URL/agents" | jq -r '.items[0].id')
[[ -n "$A_AGENT_ID" && -n "$IDLE_ID" && "$A_AGENT_ID" != "$IDLE_ID" ]] \
    && pass "two distinct agents resolved by name: $A_HANDLE acts, $IDLE_HANDLE never does" \
    || fail "could not resolve both agents by name" "$(head -c 300 <<<"$A_AGENTS")"
echo "  A(acting)=$A_HANDLE ($A_AGENT_ID)   A(idle)=$IDLE_HANDLE ($IDLE_ID)"

GRP_JSON=$(rine_b group create --name "grp$RUN_ID" --enrollment open --visibility private --json \
            2>"$WORKDIR/grp-create.err")
GRP_ID=$(jq -r '.id // empty' <<<"$GRP_JSON" 2>/dev/null)
GRP_HANDLE=$(jq -r '.handle // empty' <<<"$GRP_JSON" 2>/dev/null)
[[ -n "$GRP_ID" ]] && pass "B created open group $GRP_HANDLE ($GRP_ID)" \
    || fail "group create failed" "$(head -c 400 <<<"$GRP_JSON")$(cat "$WORKDIR/grp-create.err")"

# `--as` is mandatory from here on: a two-agent org has no shortcut left to climb to, and
# the agent that joins is the one ARM 2's answer must be admitted as (`send_group_message`
# now decides membership by the ACTING agent).
rine_a --as "$A_ACTOR" group join "$GRP_ID" > "$WORKDIR/a-join.log" 2>&1 \
    && pass "A joined the open group as $A_ACTOR" || fail "A join failed" "$(tail -5 "$WORKDIR/a-join.log")"
MEMBERS=$(api_get "$A_TOKEN" "$API_URL/groups/$GRP_ID/members" | jq -r '[.items[]?.agent_id] | length')
[[ "$MEMBERS" == "2" ]] && pass "server confirms 2 members" || fail "member count is $MEMBERS, expected 2" ""

# ---------------------------------------------------------------------------
section "2 · the model provider the rig has never had"
# ---------------------------------------------------------------------------
MODELS=$(oc 'node node_modules/openclaw/openclaw.mjs models list --provider together 2>&1 | head -20')
grep -qi "llama\|together" <<<"$MODELS" \
    && pass "openclaw resolves the together provider inside the rig" \
    || fail "together provider not resolvable" "$(tail -5 <<<"$MODELS")"

# ---------------------------------------------------------------------------
section "3 · ARM 1 (control) — a 1:1 DM to the OpenClaw agent"
# ---------------------------------------------------------------------------
GWLOG="$WORKDIR/gateway.log"
gateway_bg "$GWLOG" 480
if gateway_wait "$GWLOG" 60 'rine: notify service starting \(transport=sse'; then
    pass "gateway up, rine SSE notify service started"
else
    fail "notify service never started" "$(tail -15 "$GWLOG")"; gateway_stop; e2e_summary
fi
# A cursorless first-ever connect starts in CATCH-UP and flips to live only on the first
# heartbeat/status frame (transports/sse.ts:140-141), which is idle-driven at ~30 s. A DM
# sent before that is tagged `replayed` and deliberately gets no auto-reply — which would
# silently void the control arm. Wait the stream into its live phase first.
echo "  waiting 45s for the SSE stream to leave catch-up (first heartbeat) …"
sleep 45

DM_MARK="dm-$RUN_ID"
DM_LINES_BEFORE=$(wc -l < "$GWLOG")   # the control arm's window in the gateway log
rine_b send --to "$A_HANDLE" --payload "{\"text\":\"$DM_MARK please answer with one short sentence\"}" \
    > "$WORKDIR/b-dm.log" 2>&1 \
    && pass "B sent a 1:1 DM to A" || fail "1:1 send failed" "$(tail -3 "$WORKDIR/b-dm.log")"

gateway_wait "$GWLOG" 60 'rine: inbound .* → dispatching' \
    && pass "gateway woke on the 1:1 DM" || fail "no wake on the 1:1" "$(grep -i rine "$GWLOG" | tail -8)"

# Wait for an agent turn to complete and the reply to be created server-side.
DM_REPLIES=0
for _ in $(seq 1 90); do
    DM_REPLIES=$(psql_q "SELECT count(*) FROM messages WHERE from_agent_id='$A_AGENT_ID';")
    [[ "$DM_REPLIES" =~ ^[0-9]+$ && "$DM_REPLIES" -ge 1 ]] && break
    sleep 2
done
# Exactly one reply: a duplicate lands seconds after the first, so the count is read again once
# the turn has had time to repeat itself.
sleep 30
DM_REPLIES=$(psql_q "SELECT count(*) FROM messages WHERE from_agent_id='$A_AGENT_ID';")
[[ "$DM_REPLIES" == "1" ]] \
    && pass "CONTROL HOLDS: the agent turn ran and A sent exactly one reply ($DM_REPLIES row)" \
    || fail "control arm sent $DM_REPLIES rows from $A_ACTOR, expected exactly 1" \
            "$(grep -iE 'rine:|error|model|turn' "$GWLOG" | tail -15)"

# Who the reply came FROM — found by recency, not by presupposing the author, or the query
# would assert its own answer.
DM_MSG_ID=$(psql_q "SELECT id FROM messages WHERE to_agent_id='$A_AGENT_ID' AND from_agent_id='$B_AGENT_ID' ORDER BY created_at DESC LIMIT 1;")
REPLY_ID=$(psql_q "SELECT id FROM messages WHERE to_agent_id='$B_AGENT_ID' ORDER BY created_at DESC LIMIT 1;")
REPLY_FROM=$(psql_q "SELECT from_agent_id FROM messages WHERE id='$REPLY_ID';")
[[ "$REPLY_FROM" == "$A_AGENT_ID" ]] \
    && pass "the reply is attributed to the agent that acted ($A_ACTOR), not its idle sibling" \
    || fail "reply attributed to $REPLY_FROM — expected $A_ACTOR ($A_AGENT_ID)" \
            "idle sibling is $IDLE_ID; reply row $REPLY_ID"

# THE SILENT-FAILURE CHECK. `rine_reply` seals with `original.to_agent_id`'s key and the
# server files the row under the acting agent the same call names; if those two ever
# disagree the POST still returns 201 and the gateway logs nothing — the failure only
# exists at the counterparty, as a withheld plaintext. So ask the counterparty.
RD=$(extract_json <<<"$(rine_b message read "$REPLY_ID" --json 2>&1)")
RD_STATUS=$(jf "$RD" '.verification_status // "ABSENT"')
RD_TEXT=$(jf "$RD" '.decrypted_payload | tojson')
if [[ "$RD_STATUS" == "verified" && -n "$RD_TEXT" && "$RD_TEXT" != "null" ]]; then
    pass "COUNTERPARTY READ IT: B decrypted the reply and its signature verifies — $(head -c 70 <<<"$RD_TEXT")"
else
    fail "B could NOT read the reply — the attributed sender and the sealing key disagree" \
         "verification_status=$RD_STATUS decrypted_payload=$RD_TEXT"
fi

model_gate "1:1 control" "$DM_LINES_BEFORE"

# ---------------------------------------------------------------------------
section "4 · ARM 2 (experiment) — a GROUP post to the same agent"
# ---------------------------------------------------------------------------
BEFORE_TOTAL=$(psql_q "SELECT count(*) FROM messages;")
BEFORE_FROM_A=$(psql_q "SELECT count(*) FROM messages WHERE from_agent_id='$A_AGENT_ID';")
GRP_MARK="grp-$RUN_ID"
GW_LINES_BEFORE=$(wc -l < "$GWLOG")

rine_b send --to "$GRP_HANDLE" --payload "{\"text\":\"$GRP_MARK please answer with one short sentence\"}" \
    > "$WORKDIR/b-grp.log" 2>&1 \
    && pass "B posted to the group $GRP_HANDLE" || fail "group send failed" "$(tail -5 "$WORKDIR/b-grp.log")"

GRP_MSG_ID=$(psql_q "SELECT id FROM messages WHERE group_id='$GRP_ID' ORDER BY created_at DESC LIMIT 1;")
echo "  group post row: id=$GRP_MSG_ID  to_agent_id=$(psql_q "SELECT coalesce(to_agent_id::text,'NULL') FROM messages WHERE id='$GRP_MSG_ID';")"

gateway_wait "$GWLOG" 60 "rine: inbound .*$GRP_MSG_ID" \
    && pass "gateway woke on the GROUP post" \
    || fail "gateway never woke on the group post" "$(gw_since "$GW_LINES_BEFORE" | grep -i rine | tail -8)"

# Give the turn the same budget the control arm had.
sleep 60
AFTER_TOTAL=$(psql_q "SELECT count(*) FROM messages;")
AFTER_FROM_A=$(psql_q "SELECT count(*) FROM messages WHERE from_agent_id='$A_AGENT_ID';")
NEW_FROM_A=$(( AFTER_FROM_A - BEFORE_FROM_A ))

section "5 · what the group actually heard"
GRP_ROWS=$(psql_q "SELECT count(*) FROM messages WHERE group_id='$GRP_ID';")
A_GRP_ROWS=$(psql_q "SELECT count(*) FROM messages WHERE group_id='$GRP_ID' AND from_agent_id='$A_AGENT_ID';")
echo "  messages total       before=$BEFORE_TOTAL after=$AFTER_TOTAL"
echo "  rows from A          before=$BEFORE_FROM_A after=$AFTER_FROM_A  (new: $NEW_FROM_A)"
echo "  rows in the group    total=$GRP_ROWS   from A=$A_GRP_ROWS"
echo ""
echo "  --- every messages row, ordered (id | from | to | group | conversation | type) ---"
rows_dump "left(id::text,8)" "CASE WHEN group_id IS NULL THEN 'NULL' ELSE 'GRP' END" \
          "left(conversation_id::text,8)" | sed 's/^/  /'
echo ""
echo "  --- message_deliveries for the group post $GRP_MSG_ID ---"
psql_q "SELECT agent_id, delivered_at FROM message_deliveries WHERE message_id='$GRP_MSG_ID';" | sed 's/^/  /'
echo ""
echo "  --- gateway lines since the group post ---"
gw_since "$GW_LINES_BEFORE" | grep -iE "rine:|outbound|reply|error|group" | tail -30 | sed 's/^/  /'

# The assertion this lane exists for. A group is answered by SENDING to the group, so A's turn
# must produce a row IN the group. Before `answerRouteOf` routed groups to `sendRineText`, this
# count was zero and no test on any surface could see it.
# Exactly one, and admitted as the acting agent (the only org-A member of the group).
if [[ "$A_GRP_ROWS" == "1" ]]; then
    pass "MEASURED: the group heard exactly one answer — 1 row in $GRP_ID admitted as $A_ACTOR"
else
    fail "the group did not hear exactly one answer as $A_ACTOR — rows in $GRP_ID admitted as $A_ACTOR=$A_GRP_ROWS (rows from $A_ACTOR outside the group, such as the sender-key hand-off, are not replies)" \
         "$(gw_since "$GW_LINES_BEFORE" | grep -iE 'rine:|outbound|reply|error' | tail -20)"
fi

# Anything else $A_ACTOR sent outside the group since the post is a second answer by another
# route (a duplicate 1:1 to the poster would pass the count above); only the sender-key hand-off
# that a first group post triggers is expected.
STRAY_FROM_A=$(psql_q "SELECT count(*) FROM messages WHERE from_agent_id='$A_AGENT_ID' AND group_id IS NULL
    AND type <> 'rine.v1.sender_key_distribution' AND created_at >= (SELECT created_at FROM messages WHERE id='$GRP_MSG_ID');")
if [[ "$STRAY_FROM_A" == "0" ]]; then
    pass "MEASURED: $A_ACTOR sent nothing outside the group but the sender-key hand-off"
else
    fail "$A_ACTOR sent $STRAY_FROM_A message(s) outside the group besides the sender-key hand-off" \
         "$(rows_dump "left(id::text,8)" "CASE WHEN group_id IS NULL THEN 'NULL' ELSE 'GRP' END" "left(conversation_id::text,8)" | tail -6)"
fi

# And it must not have gone through the reply route and been swallowed. `replyToRine`'s catch
# turns a refusal into one `logger.error` the operator never connects to a silent group.
if gw_since "$GW_LINES_BEFORE" | grep -q "outbound reply failed"; then
    fail "the outbound path failed and swallowed it into a single logger.error line" \
         "$(gw_since "$GW_LINES_BEFORE" | grep -o 'rine: outbound reply failed.*' | head -3)"
else
    pass "MEASURED: no swallowed 'outbound reply failed' line for the group post"
fi

# Same gate over the group arm's own window: the row count above is satisfied by an error
# reply posted to the group exactly as it is by an answer.
model_gate "group" "$GW_LINES_BEFORE"

gateway_stop

# ---------------------------------------------------------------------------
section "6 · ARM 3 (attribution) — who may reply, as whom, and whose read burns"
# ---------------------------------------------------------------------------
# Scripted, and deliberately so: these are the questions a model turn cannot pose. A reply
# that names NO actor, a reply named as the sibling that was never addressed, and a read by
# an agent the message never reached. Each assertion below states what the PRE-phase server
# answered — one that both eras pass proves nothing about this release and is marked as such.
A_TOKEN=$(get_token "$A_DIR")   # minutes have passed; the 900 s token may have turned over
REPLY_BODY='{"type":"rine.v1.dm","encrypted_payload":"cHJvYmU","encryption_version":"hpke-hybrid-v2"}'
PROBE_CODE=""; PROBE_BODY=""

# `-` for "name no actor at all" — the distinction between an absent header and an
# unresolvable one is itself under test, so it cannot be spelled as an empty string.
probe() {  # <method> <path> <actor|-> [body]
    local method="$1" path="$2" actor="$3" body="${4:-}"
    local -a args=(-s -o "$WORKDIR/probe.body" -w '%{http_code}' -X "$method"
                   -H "Authorization: Bearer $A_TOKEN")
    [[ "$actor" == "-" ]] || args+=(-H "X-Rine-Agent: $actor")
    [[ -z "$body" ]] || args+=(-H "Content-Type: application/json" -d "$body")
    PROBE_CODE=$(curl "${args[@]}" "$API_URL$path")
    PROBE_BODY=$(cat "$WORKDIR/probe.body")
}
mark_of() { psql_q "SELECT coalesce(delivered_at::text,'NULL') FROM messages WHERE id='$1';"; }

ROWS_BEFORE_PROBES=$(psql_q "SELECT count(*) FROM messages;")

# 6.1 — DISCRIMINATES. Pre-phase this answered 201 and filed the reply under whichever agent
# the original named; the header decided nothing. It is also a DEGRADE: a call that used to
# succeed now refuses, which is why the refusal has to name the agents to choose between.
probe POST "/messages/$DM_MSG_ID/reply" - "$REPLY_BODY"
if [[ "$PROBE_CODE" == "422" ]] && grep -q "Multiple active agents" <<<"$PROBE_BODY" \
   && grep -q "$A_HANDLE" <<<"$PROBE_BODY"; then
    pass "a header-less reply from a two-agent org is refused (422) and the refusal lists both agents"
else
    fail "header-less reply answered $PROBE_CODE — pre-phase behaviour was 201" \
         "$(head -c 220 <<<"$PROBE_BODY")"
fi

# 6.2 — DISCRIMINATES. Pre-phase a sibling's reply was accepted and attributed to the
# addressee: the sibling's own name never appeared, and B saw an answer from `ops` that
# `ops` never wrote.
probe POST "/messages/$DM_MSG_ID/reply" "$IDLE_ID" "$REPLY_BODY"
if [[ "$PROBE_CODE" == "403" ]] && grep -q "not a party" <<<"$PROBE_BODY"; then
    pass "the sibling that was never addressed cannot reply (403, 'not a party')"
else
    fail "sibling reply answered $PROBE_CODE — pre-phase it was 201, attributed to $A_ACTOR" \
         "$(head -c 220 <<<"$PROBE_BODY")"
fi

# 6.3 — the refusals must be refusals, not 4xx after a write.
ROWS_AFTER_REFUSALS=$(psql_q "SELECT count(*) FROM messages;")
[[ "$ROWS_AFTER_REFUSALS" == "$ROWS_BEFORE_PROBES" ]] \
    && pass "neither refusal created a message row ($ROWS_BEFORE_PROBES unchanged)" \
    || fail "a refused reply still wrote rows: $ROWS_BEFORE_PROBES → $ROWS_AFTER_REFUSALS" ""

# 6.4/6.5 — THE ATTRIBUTION FLIP, and the only assertion here whose two eras differ by the
# row itself rather than the status code. `ops` messages its own sibling, then replies to
# its OWN message as `ops`: post-phase the reply is ops→assistant, pre-phase the derivation
# picked the addressee first and wrote the exact inversion, assistant→ops. Both are 201.
rine_a --as "$A_ACTOR" send --to "$IDLE_HANDLE" --payload "{\"text\":\"sib-$RUN_ID\"}" \
    > "$WORKDIR/a-sib.log" 2>&1 \
    && pass "$A_ACTOR sent a same-org DM to $A_IDLE (the two-party original the flip needs)" \
    || fail "same-org send failed" "$(tail -4 "$WORKDIR/a-sib.log")"
SIB_ID=$(psql_q "SELECT id FROM messages WHERE from_agent_id='$A_AGENT_ID' AND to_agent_id='$IDLE_ID' ORDER BY created_at DESC LIMIT 1;")
probe POST "/messages/$SIB_ID/reply" "$A_AGENT_ID" "$REPLY_BODY"
FLIP_ID=$(jf "$PROBE_BODY" '.id // empty')
FLIP_ROW=$(psql_q "SELECT from_agent_id || ' -> ' || to_agent_id FROM messages WHERE id='$FLIP_ID';")
if [[ "$PROBE_CODE" == "201" && "$FLIP_ROW" == "$A_AGENT_ID -> $IDLE_ID" ]]; then
    pass "ATTRIBUTION IS THE ACTOR'S: the reply is filed $A_ACTOR→$A_IDLE (pre-phase: the inversion, $A_IDLE→$A_ACTOR)"
else
    fail "reply row is '$FLIP_ROW', expected '$A_AGENT_ID -> $IDLE_ID' (http $PROBE_CODE)" \
         "$A_ACTOR=$A_AGENT_ID $A_IDLE=$IDLE_ID; $(head -c 160 <<<"$PROBE_BODY")"
fi

# 6.6 — THE PER-READER MARK. A fresh unread DM, then four reads. Pre-phase, ANY read by the
# recipient ORG flipped `delivered_at` — the first three all burned it, and `delivered_at`
# gates SSE catch-up, /poll and ?status=new, so the addressee simply never saw the message.
#
# Addressed to the IDLE sibling, not to `ops`, and that is not incidental: a delivery mark is
# also written by the SSE stream, which is subscribed as `ops`. Addressing `ops` would make
# every "nothing marked it" assertion depend on the gateway being fully gone — which it was
# not, and which no assertion here should have to trust. Nothing streams `assistant`.
rine_b send --to "$IDLE_HANDLE" --payload "{\"text\":\"mark-$RUN_ID\"}" > "$WORKDIR/b-mark.log" 2>&1 \
    && pass "B sent a fresh DM to $A_IDLE — an addressee no stream is subscribed to" \
    || fail "mark-probe send failed" "$(tail -3 "$WORKDIR/b-mark.log")"
MARK_ID=$(psql_q "SELECT id FROM messages WHERE to_agent_id='$IDLE_ID' AND from_agent_id='$B_AGENT_ID' ORDER BY created_at DESC LIMIT 1;")

probe GET "/messages/$MARK_ID" -
[[ "$PROBE_CODE" == "200" && "$(mark_of "$MARK_ID")" == "NULL" ]] \
    && pass "a read that names NO agent answers 200 and marks nothing (pre-phase: it marked)" \
    || fail "header-less read: http $PROBE_CODE, delivered_at=$(mark_of "$MARK_ID")" ""

probe GET "/messages/$MARK_ID" "$A_AGENT_ID"
[[ "$PROBE_CODE" == "200" && "$(mark_of "$MARK_ID")" == "NULL" ]] \
    && pass "the sibling's read does NOT burn $A_IDLE's unread state (pre-phase: it did)" \
    || fail "sibling read: http $PROBE_CODE, delivered_at=$(mark_of "$MARK_ID")" ""

# A header that names an agent nobody can resolve is a caller error, not silence: left
# swallowed it would 200, mark nothing, and leave the message queued with nothing said.
probe GET "/messages/$MARK_ID" "nosuch-$RUN_ID@$A_SLUG.$MX_DOMAIN"
[[ "$PROBE_CODE" == "422" && "$(mark_of "$MARK_ID")" == "NULL" ]] \
    && pass "a named-but-unresolvable actor 422s instead of reading silently (pre-phase: 200, and it marked)" \
    || fail "unresolvable-actor read: http $PROBE_CODE, delivered_at=$(mark_of "$MARK_ID")" \
            "$(head -c 200 <<<"$PROBE_BODY")"

# The liveness half — narrowing the mark must not have removed it. Does NOT discriminate.
probe GET "/messages/$MARK_ID" "$IDLE_ID"
MARKED=$(mark_of "$MARK_ID")
UQ_LEFT=$(psql_q "SELECT count(*) FROM undelivered_queue WHERE message_id='$MARK_ID' AND agent_id='$IDLE_ID';")
[[ "$PROBE_CODE" == "200" && "$MARKED" != "NULL" && "$UQ_LEFT" == "0" ]] \
    && pass "the addressee's own read still marks it delivered and dequeues it ($MARKED, queue rows left: $UQ_LEFT)" \
    || fail "addressee read: http $PROBE_CODE, delivered_at=$MARKED, undelivered_queue rows=$UQ_LEFT" ""

# Artefacts land in the project's scratch dir; the gateway log and the agent transcript are the
# only places a tool RESULT is visible, and a failed run is read from them.
ARTEFACTS="$PROJECT_ROOT/_TEMP/openclaw-group-reply"
mkdir -p "$ARTEFACTS/sessions"
cp "$GWLOG" "$ARTEFACTS/gateway.log" 2>/dev/null
cp -r "$E2E_OC_STATE_DIR/agents" "$ARTEFACTS/sessions/" 2>/dev/null
rows_dump "id::text" "coalesce(group_id::text,'NULL')" "conversation_id::text" > "$ARTEFACTS/rows.txt"
echo ""
echo "  artefacts: $ARTEFACTS"
e2e_summary
