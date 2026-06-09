# Base image for the CONTAINED OpenClaw plugin dev/test/E2E rig.
# openclaw and all node deps install INSIDE the container (see ../compose.openclaw.yml).
# Nothing OpenClaw-related is ever installed on the host.
FROM node:24-bookworm-slim

# Build toolchain for any native deps (e.g. better-sqlite3 used by openclaw's cron store),
# plus git/curl/jq for git deps and E2E probing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates curl jq \
 && rm -rf /var/lib/apt/lists/*

ENV npm_config_fund=false \
    npm_config_audit=false \
    CI=true

WORKDIR /work/rine-openclaw

# Long-lived by default so the rig can host a gateway for E2E; one-shot tasks use
# `docker compose -f compose.openclaw.yml run --rm plugin <cmd>`.
CMD ["sleep", "infinity"]
