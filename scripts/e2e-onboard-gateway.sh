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

# Background the contained gateway. $1=log file, $2=self-terminate seconds.
gateway_bg() {
    "${COMPOSE[@]}" run --rm -T --entrypoint sh plugin -c \
        "timeout $2 node node_modules/openclaw/openclaw.mjs gateway --bind loopback --allow-unconfigured 2>&1" \
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

gateway_stop() { kill "$GW_PID" 2>/dev/null; wait "$GW_PID" 2>/dev/null; }

# ---------------------------------------------------------------------------
# Stage: the real gateway boots on a never-onboarded install.
# ---------------------------------------------------------------------------
gateway_stage_uncredentialed() {
    local log="$WORKDIR/gateway-nocreds.log"
    gateway_bg "$log" 30
    if gateway_wait "$log" 45 '\[gateway\] ready'; then
        pass "real openclaw gateway reaches 'ready' with an EMPTY credential dir"
    else
        fail "gateway did not reach ready without credentials" "$(tail -5 "$log" 2>/dev/null)"
    fi
    grep -qE 'plugins.*\brine\b' "$log" \
        && pass "gateway loaded the rine plugin uncredentialed" \
        || fail "gateway did not load the rine plugin" "$(grep -i plugin "$log" | head -3)"
    if grep -qE 'rine: no credentials.json .* notify service idle' "$log"; then
        pass "notify service degrades gracefully (idle + actionable message, no crash)"
        echo "  agent-facing line: $(grep -oE 'rine: no credentials.json.*' "$log" | head -1)"
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
    gateway_bg "$log" 75
    if gateway_wait "$log" 45 'rine: notify service starting \(transport=sse'; then
        pass "notify service starts the SSE transport with the freshly-onboarded identity"
        echo "  $(grep -oE 'rine: notify service starting.*' "$log" | head -1)"
    else
        fail "SSE notify service did not start post-onboarding" "$(grep -i rine "$log" | tail -5)"
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
