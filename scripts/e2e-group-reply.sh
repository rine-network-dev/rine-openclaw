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
export E2E_API_HOST=0.0.0.0

# The credential gate, BEFORE the rig is stood up: a missing key must cost nothing and must not
# read as a pass. Checked here rather than after sourcing e2e-lib.sh, which boots postgres.
_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ ! -r "$_repo_root/.env.e2e" ]]; then
    echo "SKIPPED: $_repo_root/.env.e2e is missing or unreadable." >&2
    echo "  This lane needs a model provider — see the header. Nothing was started." >&2
    exit 2
fi
set -a; source "$_repo_root/.env.e2e"; set +a
if [[ -z "${TOGETHER_API_KEY:-}" ]]; then
    echo "SKIPPED: .env.e2e carries no TOGETHER_API_KEY. Nothing was started." >&2
    exit 2
fi

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/e2e-lib.sh"

MX_DOMAIN="${SMOKE_MX_DOMAIN:-gmail.com}"
RUN_ID="$RANDOM$RANDOM"
A_SLUG="ocg-$RUN_ID"      # the OpenClaw-hosted agent's org
B_SLUG="ocgp-$RUN_ID"     # the peer that messages it
MODEL="together/${RINE_E2E_MODEL:-meta-llama/Llama-3.3-70B-Instruct-Turbo}"
A_ACTOR="ops"             # org A's ACTING agent: the gateway binds to it, B addresses it
A_IDLE="assistant"        # the sibling that never acts — what makes the org multi-agent

export E2E_OC_UID="$(id -u)" E2E_OC_GID="$(id -g)"
export E2E_OC_CREDS_DIR="$WORKDIR/oc-rine"
export E2E_OC_STATE_DIR="$WORKDIR/oc-state"
export RINE_API_URL="http://host.docker.internal:${E2E_API_PORT}"
mkdir -p "$E2E_OC_CREDS_DIR" "$E2E_OC_STATE_DIR"

# `agentId` is load-bearing, not decoration. Org A holds two agents, so the notify service's
# own resolve (`resolveBoundAgentId`) has no single-agent shortcut left and the service would
# idle without it — and the same setting is what binds every EXPOSED tool call the model makes
# to `ops` (`withActingAgent`). The INTERNAL `rine_reply` behind the auto-answer is deliberately
# not wrapped: it derives its actor from the message it is answering, which is the derivation
# ARM 1 exists to check.
cat > "$E2E_OC_STATE_DIR/openclaw.json" <<JSON
{
  "meta": { "lastTouchedVersion": "2026.6.1" },
  "logging": { "redactSensitive": "tools" },
  "gateway": { "mode": "local", "bind": "loopback", "auth": { "mode": "none" } },
  "agents": { "defaults": { "model": { "primary": "$MODEL" } } },
  "channels": {
    "rine": { "transport": "sse", "agentId": "$A_ACTOR", "allowFrom": ["*"], "healthMonitor": { "enabled": false } }
  },
  "plugins": {
    "entries": { "rine": { "enabled": true } },
    "load": { "paths": ["/work/rine-openclaw"] }
  }
}
JSON

COMPOSE=(docker compose -f "$PROJECT_ROOT/compose.openclaw.yml"
         -f "$PROJECT_ROOT/compose.openclaw.e2e-onboard.yml"
         -f "$PROJECT_ROOT/compose.openclaw.together.yml")

oc() { "${COMPOSE[@]}" run --rm --entrypoint sh plugin -c "$1" 2>&1 |
       grep -vE '^(\[|Creating|Container |Network |Volume )|npm_config'; }

psql_q() { docker exec "$PG_CONTAINER" psql -U rine -d rine -At -c "$1" 2>&1; }

# How a row's endpoints are named, for both dumps below. Three identities exist now, so
# "not A" can no longer mean B — an unlabelled sibling row would read as the peer's, which
# is the exact confusion this lane is here to detect.
who() { echo "CASE WHEN $1 IS NULL THEN 'NULL' WHEN $1='$A_AGENT_ID' THEN 'A:$A_ACTOR' WHEN $1='$IDLE_ID' THEN 'A:$A_IDLE' ELSE 'B' END"; }
rows_dump() {  # <id-expr> <group-expr> <conversation-expr>
    psql_q "SELECT to_char(created_at,'HH24:MI:SS') || ' | ' || $1 || ' | from=' || $(who from_agent_id) ||
            ' | to=' || $(who to_agent_id) || ' | group=' || $2 || ' | conv=' || $3 || ' | ' || type
            FROM messages ORDER BY created_at;"
}

GW_CONTAINER="ocg-gw-$RUN_ID"
gateway_bg() {
    "${COMPOSE[@]}" run --rm -T --name "$GW_CONTAINER" --entrypoint sh plugin -c \
        "timeout $2 node node_modules/openclaw/openclaw.mjs gateway --bind loopback --allow-unconfigured --verbose 2>&1" \
        > "$1" 2>&1 &
    GW_PID=$!
}
gateway_wait() {
    for _ in $(seq 1 "$2"); do grep -qE "$3" "$1" 2>/dev/null && return 0; sleep 1; done
    return 1
}
# Killing the `compose run` CLIENT does not stop the CONTAINER — it only closes the pipe the
# log arrives on, so the gateway looks dead and keeps running for the rest of its `timeout`.
# Its SSE stream is agent-scoped and an SSE yield IS a delivery, so anything sent afterwards
# gets marked delivered by a gateway the script believes it stopped. Measured: a probe one
# second after `gateway_stop` raced it and read the stream's mark as the server's. Remove the
# container by its own name — never by project label, which would reach a co-running lane.
gateway_stop() {
    kill "$GW_PID" 2>/dev/null; wait "$GW_PID" 2>/dev/null
    docker rm -f "$GW_CONTAINER" >/dev/null 2>&1
    for _ in $(seq 1 15); do
        docker ps -q --filter "name=^${GW_CONTAINER}$" | grep -q . || return 0
        sleep 1
    done
    echo "  WARNING: $GW_CONTAINER still running — later probes may race its SSE stream" >&2
}

# ---------------------------------------------------------------------------
section "1 · identities and an open group A belongs to"
# ---------------------------------------------------------------------------

A_DIR="$E2E_OC_CREDS_DIR"; B_DIR="$WORKDIR/peer"; mkdir -p "$B_DIR"
rine_a() { RINE_API_URL="$API_URL" RINE_CONFIG_DIR="$A_DIR" $CLI "$@"; }
rine_b() { RINE_API_URL="$API_URL" RINE_CONFIG_DIR="$B_DIR" $CLI "$@"; }

rine_a onboard --email "$A_SLUG@$MX_DOMAIN" --name "OC group $RUN_ID" --slug "$A_SLUG" \
       --agent-name "$A_IDLE" > "$WORKDIR/a-onboard.log" 2>&1 \
    && pass "OpenClaw agent A onboarded into the rig's bind-mounted config dir" \
    || fail "A onboarding failed" "$(tail -4 "$WORKDIR/a-onboard.log")"
rine_b onboard --email "$B_SLUG@$MX_DOMAIN" --name "Peer $RUN_ID" --slug "$B_SLUG" \
       --agent-name peer > "$WORKDIR/b-onboard.log" 2>&1 \
    && pass "peer B onboarded" \
    || fail "B onboarding failed" "$(tail -4 "$WORKDIR/b-onboard.log")"

A_TOKEN=$(get_token "$A_DIR"); B_TOKEN=$(get_token "$B_DIR")

# The second agent, minted into the SAME config dir — so both agents' signing keys are
# local, which is precisely what makes a mis-sealed reply possible and therefore worth
# asserting against.
rine_a agent create --name "$A_ACTOR" > "$WORKDIR/a-actor.log" 2>&1 \
    && pass "org A holds a second agent ($A_ACTOR) — the single-agent shortcut is gone" \
    || fail "creating $A_ACTOR failed" "$(tail -4 "$WORKDIR/a-actor.log")"

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
# the agent that joins is the one ARM 2's answer must be admitted as (`_send_group_message`
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
[[ "$DM_REPLIES" -ge 1 ]] \
    && pass "CONTROL HOLDS: the agent turn ran and A's reply reached the server ($DM_REPLIES row)" \
    || fail "control arm produced no reply — the LLM turn or deliver() never ran" \
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

# ---------------------------------------------------------------------------
section "4 · ARM 2 (experiment) — a GROUP post to the same agent"
# ---------------------------------------------------------------------------
BEFORE_TOTAL=$(psql_q "SELECT count(*) FROM messages;")
BEFORE_FROM_A=$(psql_q "SELECT count(*) FROM messages WHERE from_agent_id='$A_AGENT_ID';")
GRP_MARK="grp-$RUN_ID"
: > "$WORKDIR/gw-mark"; GW_LINES_BEFORE=$(wc -l < "$GWLOG")

rine_b send --to "$GRP_HANDLE" --payload "{\"text\":\"$GRP_MARK please answer with one short sentence\"}" \
    > "$WORKDIR/b-grp.log" 2>&1 \
    && pass "B posted to the group $GRP_HANDLE" || fail "group send failed" "$(tail -5 "$WORKDIR/b-grp.log")"

GRP_MSG_ID=$(psql_q "SELECT id FROM messages WHERE group_id='$GRP_ID' ORDER BY created_at DESC LIMIT 1;")
echo "  group post row: id=$GRP_MSG_ID  to_agent_id=$(psql_q "SELECT coalesce(to_agent_id::text,'NULL') FROM messages WHERE id='$GRP_MSG_ID';")"

gateway_wait "$GWLOG" 60 "rine: inbound .*$GRP_MSG_ID" \
    && pass "gateway woke on the GROUP post" \
    || fail "gateway never woke on the group post" "$(tail -n +"$GW_LINES_BEFORE" "$GWLOG" | grep -i rine | tail -8)"

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
tail -n +"$GW_LINES_BEFORE" "$GWLOG" | grep -iE "rine:|outbound|reply|error|group" | tail -30 | sed 's/^/  /'

# The assertion this lane exists for. A group is answered by SENDING to the group, so A's turn
# must produce a row IN the group. Before `answerRouteOf` routed groups to `sendRineText`, this
# count was zero and no test on any surface could see it.
if [[ "$A_GRP_ROWS" -ge 1 ]]; then
    pass "MEASURED: the group heard the answer — $A_GRP_ROWS row(s) in $GRP_ID authored by A"
else
    fail "the group heard NOTHING — zero rows in group $GRP_ID authored by A" \
         "$(tail -n +"$GW_LINES_BEFORE" "$GWLOG" | grep -iE 'rine:|outbound|reply|error' | tail -20)"
fi

# And it must not have gone through the reply route and been swallowed. `replyToRine`'s catch
# turns a refusal into one `logger.error` the operator never connects to a silent group.
if tail -n +"$GW_LINES_BEFORE" "$GWLOG" | grep -q "outbound reply failed"; then
    fail "the outbound path failed and swallowed it into a single logger.error line" \
         "$(tail -n +"$GW_LINES_BEFORE" "$GWLOG" | grep -o 'rine: outbound reply failed.*' | head -3)"
else
    pass "MEASURED: no swallowed 'outbound reply failed' line for the group post"
fi

gateway_stop

# ---------------------------------------------------------------------------
section "6 · ARM 3 (attribution) — who may reply, as whom, and whose read burns"
# ---------------------------------------------------------------------------
# Scripted, and deliberately so: these are the questions a model turn cannot pose. A reply
# that names NO actor, a reply named as the sibling that was never addressed, and a read by
# an agent the message never reached. Each assertion below states what the PRE-phase server
# answered — one that both eras pass proves nothing about this release and is marked as such.
A_TOKEN=$(get_token "$A_DIR")   # minutes have passed; the 900 s token may have turned over
REPLY_BODY='{"type":"rine.v1.dm","encrypted_payload":"cHJvYmU"}'
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
