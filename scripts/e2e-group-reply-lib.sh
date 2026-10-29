#!/usr/bin/env bash
# Sourced by e2e-group-reply.sh: the rig and database helpers, the row dumps, the gateway
# lifecycle and the model gate. Needs COMPOSE, PG_CONTAINER, GWLOG, MODEL_ID and the identity
# variables the main script sets before it calls any of them.
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
# openclaw 2026.9.6 hands a bundled plugin's module to whichever loaded plugin's root prefixes
# its path, so a host started from /work/rine-openclaw/node_modules/openclaw dies on its first
# agent turn ("Plugin entry is outside its captured source package"). The override file mounts
# the same node_modules volume a second time, outside the plugin root; the host runs from there.
OC_HOST="/ochost/node_modules/openclaw"
gateway_bg() {
    # Pre-emptive removal, the same shape `e2e-onboard-gateway.sh:gateway_bg` carries: a
    # container left by a crashed prior run makes `run --name` fail on a name conflict, and
    # that reads as a docker problem rather than as the missing line it is. This suite calls
    # gateway_bg once per run so the collision needs a previous run to happen — which is
    # exactly the case that is hardest to recognise from the failure text.
    docker rm -f "$GW_CONTAINER" >/dev/null 2>&1
    "${COMPOSE[@]}" run --rm -T --name "$GW_CONTAINER" --entrypoint sh plugin -c \
        "timeout $2 node $OC_HOST/openclaw.mjs gateway --bind loopback --allow-unconfigured --verbose 2>&1" \
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
    kill "${GW_PID:-}" 2>/dev/null; wait "${GW_PID:-}" 2>/dev/null
    # An empty name would make `docker rm -f ""` and the ps filter below meaningless; the
    # sibling file guards the same way. gateway_stop is reachable from a failure path that
    # ran before gateway_bg.
    [[ -n "$GW_CONTAINER" ]] || return 0
    docker rm -f "$GW_CONTAINER" >/dev/null 2>&1
    for _ in $(seq 1 15); do
        docker ps -q --filter "name=^${GW_CONTAINER}$" | grep -q . || return 0
        sleep 1
    done
    echo "  WARNING: $GW_CONTAINER still running — later probes may race its SSE stream" >&2
}

# ── "did the MODEL actually answer?" ────────────────────────────────────────
# 🔴 Section 2's provider check greps `models list --provider together` for "llama|together"
# — and EVERY line of that table contains "together/", including the row the table itself
# tags `missing`. It cannot fail. Measured 2026-09-04: three consecutive runs of this suite
# scored an identical 28 PASSED / 0 FAILED, and in two of them the model never answered at
# all ("Unknown model: together/zai-org/GLM-5.3-Flash", then 'Provider "together" requires an
# explicit base URL before using an OpenAI-compatible API'). Every assertion held, because
# openclaw delivers its OWN error copy as a real, signed, decryptable rine message — so
# "CONTROL HOLDS", "COUNTERPARTY READ IT" and "the group heard the answer" are all satisfied
# by a failure. A suite that scores the same with and without a working model measures the
# transport, not the product.
#
# Gate each arm on the two things only a real completion produces, inside that arm's own
# window of the gateway log:
#
#   POSITIVE  a provider round-trip that came back 200 for the model THIS run configured:
#             `[provider-transport-fetch] [model-fetch] response … model=<id> status=200`
#   NEGATIVE  zero `embedded run agent end: … isError=true` — the line openclaw's failover
#             path writes for every one of those canned replies, together with the copy it
#             is about to send (openclaw src/agents/embedded-agent-subscribe.handlers
#             .lifecycle.ts, the `log.warn` branch; the success branch logs isError=false at
#             debug, which is why this gateway runs --verbose). ⚠️ That last clause is about
#             the NEGATIVE leg only. The positive leg's `[model-fetch] response` lines emit
#             at INFO (openclaw src/agents/model-transport-debug.test.ts asserts
#             `info` was called and `debug` was not), so --verbose is not load-bearing for it.
#
# 🔴 What this gate CANNOT do, said here rather than discovered from a red run: the two legs
# are not correlated by run id. The negative leg fails on ANY turn in the window that ended
# isError=true, not on the graded reply's own turn — so a concurrent or unrelated erroring run
# inside the same window turns the arm RED while the graded reply came from the model exactly
# as required. And nothing pins the `isError=true` literal upstream: if openclaw renames it,
# the negative leg becomes permanently unsatisfiable and this gate passes forever in silence.
# Both are open — the scan window is wider than the graded turn, and the `isError=true`
# literal is pinned nowhere upstream; neither is a reason to loosen the arm.
#
# Neither leg can be satisfied by an error reply, and neither replaces an existing assertion
# — both arms are additions, so the recorded 28/0 baseline becomes 30/0.
gw_since() { tail -n +"$(( ${1:-0} + 1 ))" "$GWLOG" 2>/dev/null; }
model_gate() {   # $1 = arm label, $2 = the log's line count when the arm started
    local arm="$1" from="${2:-0}" ok err
    ok=$(gw_since "$from" | grep -F -- '[model-fetch] response' \
                          | grep -cF -- "model=$MODEL_ID status=200")
    err=$(gw_since "$from" | grep -cE 'embedded run agent end:.*isError=true')
    if [[ "$ok" -ge 1 && "$err" -eq 0 ]]; then
        pass "THE MODEL ANSWERED ($arm): $ok completion(s) returned 200 for $MODEL_ID, and no turn ended isError=true"
    else
        fail "the $arm reply did not come from the model — openclaw's own error copy would pass every other assertion here" \
             "200-responses for $MODEL_ID=$ok (need >=1); turns ending isError=true=$err (need 0); $(gw_since "$from" | grep -oE 'embedded run agent end:.*isError=true.*|\[model-fetch\] response .*' | tail -2 | tr '\n' ' ')"
    fi
}

