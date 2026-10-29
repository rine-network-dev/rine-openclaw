#!/usr/bin/env bash
# Real-gateway stages for e2e-onboard.sh (sourced, not run directly).
#
# Everything above this file exercises the plugin's tool surface. These two stages run the
# ACTUAL `openclaw gateway` process inside the contained rig, because two things only the
# gateway can prove: (a) a fresh install does not crash the gateway before onboarding, and
# (b) the rine CHANNEL — the notify service + SSE transport — actually wakes on an inbound
# message. openclaw runs from the container's node_modules; nothing is installed on the host.
#
# Expects from the caller: COMPOSE, WORKDIR, CLI, API_URL, pass/fail, A_HANDLE, B_DIR.

# Background the contained gateway. $1=log file, $2=self-terminate seconds, $3=container name.
# The name is what `gateway_stop` removes; every stage passes its own so a stage that ends
# badly can never leave a container the next stage's name would collide with.
GW_CONTAINER=""
gateway_bg() {
    GW_CONTAINER="$3"
    docker rm -f "$GW_CONTAINER" >/dev/null 2>&1
    "${COMPOSE[@]}" run --rm -T --name "$GW_CONTAINER" --entrypoint sh plugin -c \
        "exec timeout $2 node node_modules/openclaw/openclaw.mjs gateway --bind loopback --allow-unconfigured 2>&1" \
        > "$1" 2>&1 &
    GW_PID=$!
}

# Wait for a pattern to appear in a log. $1=log, $2=max seconds, $3=grep -E pattern.
gateway_wait() {
    for _ in $(seq 1 "$2"); do
        grep -qE "$3" "$1" 2>/dev/null && return 0
        sleep 1
    done
    return 1
}

# Killing the `docker compose run` CLIENT does not stop the CONTAINER — it only closes the
# pipe the log arrives on, so the gateway looks dead and keeps running for the rest of its
# `timeout`. openclaw 2026.6.1 tolerated two gateways on one state dir; 2026.9.1 REFUSES the
# second one outright ("gateway already running (pid N); lock timeout after 5000ms"), so a
# stage-2b container still alive ~12 s later takes stage 5b down with it. Remove the container
# by its own NAME — never by project label, which would reach a co-running lane. The same trap
# and the same shape as `e2e-group-reply.sh`'s `gateway_stop`.
# Stop it with SIGTERM first: 2026.9.6 keeps an owner lease in the state dir that only a clean
# shutdown releases, so a SIGKILLed stage-2b gateway makes stage 5b's refuse to start ("Another
# Gateway owner lease is still active"). `gateway_bg` EXECs `timeout` so that it, not `sh`, is
# the container's PID 1: an `sh` running as PID 1 ignores TERM, and the stop would silently
# become a KILL.
gateway_stop() {
    kill "$GW_PID" 2>/dev/null; wait "$GW_PID" 2>/dev/null
    [[ -n "$GW_CONTAINER" ]] || return 0
    docker stop --time 20 "$GW_CONTAINER" >/dev/null 2>&1
    docker rm -f "$GW_CONTAINER" >/dev/null 2>&1
    for _ in $(seq 1 15); do
        docker ps -q --filter "name=^${GW_CONTAINER}$" | grep -q . || return 0
        sleep 1
    done
    echo "  WARNING: $GW_CONTAINER still running — the next gateway stage will meet the 9.1 singleton lock" >&2
}

# ---------------------------------------------------------------------------
# Stage: the real gateway boots on a never-onboarded install.
# ---------------------------------------------------------------------------
gateway_stage_no_identity() {
    local log="$WORKDIR/gateway-nocreds.log"
    gateway_bg "$log" 30 "ocb-gw-$RUN_ID-nocreds"
    # 2026.9.6 no longer prints `[gateway] ready`; `[gateway] startup outcomes:` is logged once
    # channels and sidecars have started, and 2026.9.1 prints it too. Accept either.
    if gateway_wait "$log" 45 '\[gateway\] (ready|startup outcomes:)'; then
        pass "real openclaw gateway reaches 'ready' with EMPTY runtime and owner dirs"
    else
        fail "gateway did not reach ready without an identity" "$(tail -5 "$log" 2>/dev/null)"
    fi
    grep -qE 'plugins.*\brine\b' "$log" \
        && pass "gateway loaded the rine plugin with no identity" \
        || fail "gateway did not load the rine plugin" "$(grep -i plugin "$log" | head -3)"
    if grep -qE 'rine: no agent identity at .* notify service idle' "$log"; then
        pass "notify service degrades gracefully (idle + actionable message, no crash)"
        echo "  agent-facing line: $(grep -oE 'rine: no agent identity at.*' "$log" | head -1)"
    else
        fail "no graceful idle message from the notify service" "$(grep -i rine "$log" | head -3)"
    fi
    grep -qiE 'health-monitor.*restart' "$log" \
        && fail "health-monitor churn present despite healthMonitor.enabled=false" "$(grep -i health-monitor "$log" | head -2)" \
        || pass "no health-monitor restart churn (channels.rine.healthMonitor.enabled=false works)"
    gateway_stop
}

# ---------------------------------------------------------------------------
# Stage: post-onboarding, the SSE channel wakes on a peer's message.
# ---------------------------------------------------------------------------
gateway_stage_sse_roundtrip() {
    local log="$WORKDIR/gateway-sse.log" marker="sse-wake-$RUN_ID"
    gateway_bg "$log" 75 "ocb-gw-$RUN_ID-sse"
    if gateway_wait "$log" 45 'rine: notify service starting \(transport=sse'; then
        pass "notify service starts the SSE transport with the freshly-onboarded identity"
        echo "  $(grep -oE 'rine: notify service starting.*' "$log" | head -1)"
    else
        fail "SSE notify service did not start post-onboarding" "$(grep -i rine "$log" | tail -5)"
        # 🔴 Without a notify service there is nothing to wake, so the assertion below cannot
        # run — but leaving silently is what made this suite report 33 assertions against a
        # 34 baseline, which reads exactly like a stale expectation. Name the skip: TOTAL
        # stays 34 and the summary says which one did not run and why.
        skip "the rine CHANNEL wakes on the inbound message over SSE" \
             "the SSE notify service never started — there is nothing to wake"
        gateway_stop; return
    fi
    sleep 3   # let the stream attach before the peer sends
    RINE_API_URL="$API_URL" RINE_CONFIG_DIR="$B_DIR" $CLI send \
        --to "$A_HANDLE" --payload "{\"task\":\"$marker\"}" > "$WORKDIR/peer-send-sse.log" 2>&1 \
        || fail "peer send (SSE stage) failed" "$(tail -3 "$WORKDIR/peer-send-sse.log")"
    if gateway_wait "$log" 40 'rine: inbound .* → dispatching'; then
        pass "the rine CHANNEL wakes on the inbound message over SSE"
        echo "  $(grep -oE 'rine: inbound .*' "$log" | head -1)"
    else
        fail "gateway never logged an inbound over SSE" "$(grep -iE 'rine|sse' "$log" | tail -6)"
    fi
    # The agent turn itself needs a model provider this offline rig has none of; record what
    # happened after the wake so a dispatch regression is visible rather than silently passing.
    echo "  post-wake: $(grep -oE 'rine: (dispatch failed|inbound).*' "$log" | tail -1)"
    gateway_stop
}
