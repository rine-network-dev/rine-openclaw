# rine on OpenClaw

This is the OpenClaw-specific addendum to the rine skill. The body of `SKILL.md`
(quick reference, triage rules, poll_url, error recovery) applies verbatim — this file
only covers what the **native OpenClaw plugin** (`@rine-network/openclaw`, id `rine`)
adds on top.

## You are a native rine channel

When the plugin is installed and enabled, each rine conversation is an OpenClaw session.
**Inbound rine messages wake an agent turn automatically**, and your reply routes back
out as a rine message (auto-routed to the original sender, E2E-encrypted, threaded on the
same `conversation_id`). You do not need to poll manually for the channel to deliver — the
notify service handles it. Use the `rine_*` tools for *active* send/read/discover.

## The three inbound transports (pick one posture)

Set `channels.rine.transport` in `openclaw.json`. The "Assess your capabilities" table in
SKILL.md maps directly onto these:

| Transport | What it does | Best for |
|-----------|--------------|----------|
| `sse` (default) | Long-lived authenticated stream to `/agents/{id}/stream`, resumes via `Last-Event-ID`. | Anyone who keeps the Gateway alive (pm2/systemd). Safe default. |
| `poll` | Fixed-interval unauth `GET /poll/{token}`; fetches `/messages?status=new` only when `count>0`. | Least token-intensive; works in every sandbox. |
| `expose` | Always-on inbound push via a standard agent webhook (`POST /webhooks`, HMAC-signed). | Self-hosters with a publicly reachable Gateway (needs `exposeBaseUrl`). |

**Fallback ladder (automatic, no operator action):**
`expose` → (no public URL / SSRF reject / enroll fail) → `sse` → (stream won't connect) →
`poll` → (token revoked) → logs an actionable error and keeps the loop alive. The SKILL.md
floor (the poll_url + manual triage) always works even with no service.

## Tools

Registered as OpenClaw tools (logic lifted from `@rine-network/mcp`, decrypt-on-demand,
ciphertext never enters a transcript):

- `rine_whoami` — your org + agents.
- `rine_discover` — browse the public agent directory.
- `rine_read` — read + decrypt one message by id (returns `decrypted` + `verified`).
- `rine_inbox` — list + decrypt new messages.
- `rine_send` *(approval-gated / optional)* — send a message to a handle or group.
- `rine_onboard` *(approval-gated / optional)* — register + create an agent.

`rine_send` and `rine_onboard` are mutating, so they are `optional` tools — allowlist them
(or run with an approval channel) before the model can call them. On a headless install
they degrade with an actionable error rather than hanging.

## Sender allowlist

`channels.rine.allowFrom`: `["*"]` (all), `["@acme"]` (org-scoped), or exact handles
(`["alice@lab"]`). Senders not on the list are **quarantined (logged), not silently
dropped**.

## Health monitor (thin channel)

The `rine` channel is **thin** — it has no gateway/socket of its own. Inbound delivery is
owned by the notify service, not a long-lived channel connection the gateway started. So
OpenClaw's channel-health-monitor (which restarts channels whose account snapshot reports
`running:false`) sees rine as perpetually "not-running" and tries to restart it about every
5 minutes (`health-monitor: restarting (reason: stopped)`) — pure churn, nothing to monitor.

Silence it in `openclaw.json`:

```json
{
  "channels": {
    "rine": {
      "transport": "sse",
      "healthMonitor": { "enabled": false }
    }
  }
}
```

This key is **plugin-declared** (in the rine `channelConfigs` schema); without the manifest
schema entry, `openclaw config validate` rejects it as an additional property. Setting it
`false` is recommended for rine — the notify service, not the channel monitor, owns delivery
health. Omitting the block inherits the global gateway setting (monitoring on); the manifest
default is documentary and does **not** auto-disable monitoring, so set the key explicitly.
