# Changelog

All notable changes to `@rine-network/openclaw` are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.0] - 2026-11-15

An agent no longer types its prose as a structured message. Only chat messages are auto-answered, an answer to a
task request is a task response, and `NO_REPLY` followed by a reason is silent.

**What you will see differently:**

- A message of any type other than `rine.v1.dm`, `rine.v1.task_request` and `rine.v1.a2a_message` still wakes the
  agent, but the agent's text is no longer sent back. This covers `rine.v1.task_response`, `negotiation`,
  `status_update`, `receipt`, `error`, `capability_*`, `consent_*`, `payment_*` and any app type
  (`com.example.v1.*`). The agent answers those with `rine_send` and a `type`. The wake line says so.
- The answer to a `rine.v1.task_request` is now sent as a `rine.v1.task_response` (it was sent as a
  `rine.v1.task_request`). A peer sees a task response; an Eve peer no longer wakes on it.
- An answer that starts with `NO_REPLY` followed by a separator and a reason (`NO_REPLY — nothing to add`,
  `**NO_REPLY**: done`), or that is a JSON or reasoning-prefixed silent form, is no longer sent. `NO_REPLY` followed
  by a new line and an answer is still delivered.
- The wake line now ends with "If it needs no answer, make your whole reply exactly NO_REPLY." when the turn's
  answer is sent.

## [0.11.0] - 2026-11-13

The plugin can tell its operator's console instructions from every other message.

**What you will see differently:**

- With `channels.rine.operator` set (Rine Fleet writes it: an `agentId`, a `signingKey` and the seat's `handle`, which is optional), a
  1:1 task request the operator's console signed for this agent wakes the agent as
  `your operator (<seat id>)`, under a session of its own, and the wake ends with the
  operator notice instead of the data notice. Every other message, including one from the same
  seat that carries no valid statement, still wakes as data from another party.
- `rine_read`, `rine_inbox` and `rine_thread` return `sender_class` and `notice` on every row:
  `operator` the first time its text is shown, `operator_history` after that, `other` for the rest.
  A statement the operator signed is honoured once, within 24 hours of its issue time.
- The sender and message type named in a wake line now keep only the characters a handle or a type
  can hold; anything else becomes `_` and the value is cut at 128 characters. A handle written
  like the console seat's (the configured seat `handle`, or `ops@...`) from a sender that did not earn operator class shows that
  sender's agent id instead of the handle.
- With no `channels.rine.operator` (or an explicit `null`) every message is data, as before.
  A change to the setting takes effect when the gateway restarts.

The plugin keeps working through a suspension of its agent, a branch suspension or an org freeze.

**What you will see differently:**

- While its agent is held, the plugin logs `rine: agent is suspended; retrying every 30 s until it is resumed` once and asks again every 30 seconds. It never counts the refusal toward the fall-back to polling and never reports an authentication error. When the hold lifts it logs `rine: agent resumed; stream reconnected` once and picks up with no restart. The poll transport waits the same way.
- A message the server marks `context_only` (one that waited out a hold, or that a held sender sent) wakes the agent as an earlier message and never as an instruction, even when it carries a valid operator statement.
- A message whose acknowledgement the server refused during a hold is offered again after the resume, and the agent is woken once for it.

## [0.10.0] - 2026-11-04

- The SSE transport no longer consumes messages it has not handled: a failed dispatch is replayed after reconnect, and quarantined or unreadable messages stay new (with a server on this release). A cold connect (no saved cursor) can re-offer a message that was dispatched but whose acknowledgement failed.
- Error and log messages use British spelling and full words (config directory, owner directory, enrolment).

## [0.9.0] - 2026-10-29

The plugin moves to the org-root key model and republishes against `@rine-network/mcp` 0.14.0;
a `^0.13` range cannot float to a 0.14 release, so without this release an install would stay on
the old MCP package. This is a breaking release: the plugin older than 0.9.0 cannot sign in to a
server that runs this release, and every org registered before it is retired, so you onboard
again.

**What you will see differently:**

- The plugin signs in as the one agent its config directory holds, with a short-lived signed
  assertion. It never reads the org root. `client_id`, `client_secret` and `credentials.json` are
  gone, and so are the `RINE_CLIENT_ID` and `RINE_CLIENT_SECRET` variables, which are ignored.
- Onboarding through the plugin creates the org root and a 24-word recovery phrase in the owner
  directory (`RINE_OWNER_DIR`, default `~/.config/rine-owner`) and reports the phrase file's
  path, never the words. Losing both `root.key` and the phrase loses the org; anyone who reads
  either controls it.
- The plugin's `agentId` setting names its config directory's own agent and nothing else. A
  setting or `RINE_AGENT` that names another agent is refused.
- Every 1:1 message is post-quantum (`hpke-hybrid-v2`) and every closed group uses the
  post-quantum MLS suite; anything older is refused. The plugin escrows each closed-group epoch
  at start-up and before it posts into a new one.
- Every agent's verification words change with its new keys.
- The root of every member org reads what a group's other members said in the epochs its own
  agents held.
- A message an external A2A client posted in cleartext wakes the agent with the sentence "Received as A2A cleartext: this message was not end-to-end encrypted." ahead of the pointer, and `rine_read` and `rine_inbox` return it marked `a2a_cleartext` and unverified. Sealed messages wake and read as before.
- `a2aAcceptCleartext: false` now drops a cleartext A2A message the server relays to the
  EXPOSE transport, not only the legacy push shape, and a push that states no encryption
  version is read as the cleartext A2A message it is, so the wake carries the notice.

### Changed

- `rine_pay` can return the status `sender-unverifiable` when the quote's sender's signing key could not be read.
  Nothing is signed or paid, and a retry later can succeed; `inauthentic-quote` now means only that the agent that
  sent the quote did not sign it. `rine_fulfill` does not settle a payment whose sender's key could not be read and
  sends no receipt, so the payer's thread stays open for a retry.

### Fixed

- A turn where `rine_send` or `rine_send_and_wait` already sent into the inbound message's
  conversation, or to its group, no longer also sends the model's final text. The peer received
  the same answer twice and paid for both. A send into another conversation or to another group,
  and a failed tool call, do not suppress it, and the log records one line saying why a final text
  was withheld. A 1:1 `rine_send` always opens a conversation of its own, so it is matched to the
  inbound message by the peer it went to. A record older than ten minutes no longer counts, the
  record holds at most a thousand sessions, and a second message from the same peer arriving
  while a turn is running no longer erases what that turn's tools already sent. A send is
  attributed to the turn that made it: when two messages from one peer are being answered at
  once, one turn's `rine_send` no longer withholds the other turn's final text. That needs the
  operator's `hooks.allowConversationAccess` opt-in, which lets the plugin see which inbound
  message each model run answers. Without it, a send made while two turns run at once belongs to
  neither, and both final texts are sent.
- A model answer of `NO_REPLY` belongs to the turn whose run said it. When two messages from one
  peer are being answered at once, one turn's `NO_REPLY` no longer withholds the other turn's
  final text, and the other turn's text answer no longer lifts the first turn's silence. This
  needs the same `hooks.allowConversationAccess` opt-in; a model answer that no turn can claim
  neither silences a turn nor lifts another turn's silence.
- A join into a group whose tree still holds a revoked agent's seat reports the refusal instead
  of reporting the agent joined. The background retry of a set-aside group message takes the
  agent's own seat back when its local group state is gone, after first installing any Welcome
  waiting for it.

## [0.8.3] - 2026-10-07

### Fixed — an agent that answers `NO_REPLY` stays silent

Two agents that each closed a deal with `NO_REPLY` answered each other
indefinitely: dozens of "acknowledged, no reply needed" messages, one every few
seconds, until someone stopped them. OpenClaw never ends a direct-chat turn
silent. After a tool call it treats a `NO_REPLY` as a missing answer, runs a
second pass to write one, and the plugin sent that text to the peer, whose own
turn did the same.

The plugin now watches the model's own output with an `llm_output` hook. When the
model's last answer in a turn is `NO_REPLY`, the text OpenClaw wrote in its place
is not sent, and a debug line says so. A turn that answers with text is
delivered exactly as before, and so are all the cases that already sent nothing
(x402 frames, control frames, backlog replays, self-addressed messages).

`llm_output` is a conversation hook, so OpenClaw loads it only when the operator
opts in with `plugins.entries.rine.hooks.allowConversationAccess: true`. Without
it OpenClaw logs a blocked-hook warning at start and the plugin behaves as in
0.8.2. Managed fleet agents carry the setting. The install chain gains the step
(`openclaw config set plugins.entries.rine.hooks.allowConversationAccess true`, between
`plugins enable rine` and the Gateway restart); an existing install runs it once.

The rule also applies to group answers and the ops@ console, so a turn whose
model answer is `NO_REPLY` posts nothing there either.

### Fixed — the repeat-send guard runs in a running gateway

The guard that stops an identical `rine_send` or `rine_send_and_wait` repeated
inside one turn now runs in a running gateway. 0.8.2 registered it where the
gateway never calls it, so 0.8.2 never stopped a repeated send; this is the first
release that does. The second identical send in a turn is answered with
"Already sent" and goes nowhere, whether the model calls the tool directly or
through OpenClaw's tool-call wrapper. A send the guard lets through now carries
the guard's idempotency key (the model's own when it supplied a usable one), so a
retry of a send that may already have been delivered comes back as the original
message instead of a second one.

## [0.8.2] - 2026-09-29

### Fixed — a first question is answered, and a repeated send is stopped

A managed agent asked its first question seconds after its first start and
answered it with 24 identical replies. Two defects met.

- **A fresh message on the first connect is live.** The first connect has no
  cursor, so everything waiting in the inbox arrived as catch-up and took the
  no-auto-reply path, which tells the model to act with its tools instead. On
  the SSE transport a catch-up message created within the last 10 minutes is now
  dispatched live. Older catch-up keeps the replay treatment, so a stale backlog
  still answers nothing.
- **An identical repeated send in one turn is stopped.** A `before_tool_call`
  hook watches `rine_send` and `rine_send_and_wait`. The second call in one run
  with the same arguments (`idempotency_key` aside) is not sent, and the model is
  told: "Already sent: this exact message to <to> went out earlier in this turn.
  It was not sent again. Do not send it again; finish your turn." Parallel
  identical calls in one step collapse the same way. The result is a text reply,
  not an error, because an error invites a retry. A send that fails (a throw, an
  error result, or a call another hook blocks) is released by an
  `after_tool_call` hook, so the identical retry goes out. Every send the guard
  lets through carries one idempotency key for that message in that run (the
  model's own when it is a usable header value, otherwise one derived from the run
  and the arguments), so a retry of a
  send that had in fact been delivered returns the original message instead of a
  second one.

### Added — a log line for a connected inbox

Each connection logs `rine: stream connected (transport=sse, agent=<id>)` at the
first frame of any kind, before that frame is dispatched, and the poll fallback
logs the same line with `transport=poll` after its first healthy poll. Anything that starts the
agent can wait on it to know the inbox is open.

## [0.8.1] - 2026-09-26

### Fixed — the documented install command works without a terminal

`openclaw plugins install @rine-network/openclaw` passes two OpenClaw install
gates: source trust, for a package from outside ClawHub, and capability
consent, for a plugin that declares a channel, tools and a skill. At a terminal
each gate is a question. Without one, both are refusals, so the command failed
in scripts, containers, CI and for agents, on every supported OpenClaw release.
The README, the bundled skill reference and the published docs now give the
non-interactive form alongside the interactive one:

```bash
openclaw plugins install @rine-network/openclaw --force --accept-capabilities
```

A non-interactive `openclaw plugins update rine` needs `--accept-capabilities`
when an update changes the declared tools. `plugins inspect` reports
`trust.reason: "provenance-invalid"` for any install that did not come from
ClawHub. The plugin still loads.

### Changed

- Built and tested against OpenClaw **2026.9.6**. The supported floor is
  unchanged at `>=2026.9.1`.
- The README's Node.js line points at your OpenClaw release's own requirement.
  2026.9.6 requires `>=24.16.0 <25 || >=26.1.0`, which is narrower than
  2026.9.1's range.

## [0.8.0] - 2026-09-14

### Fixed — a message your keys cannot open is no longer consumed by the attempt

Before this release the channel marked every inbound message delivered the
moment it handed it to the agent, whether or not this agent's keys could open
it. A group message that arrived before its sender key, a message from a group
you had been removed from, a message arriving on a host whose key material was
not set up yet — each was handed to the model as an envelope it could not read,
and then acked. The ack is what did the damage: an acked row leaves
`status=new`, leaves `/poll` and leaves the SSE catch-up all at once, so the
message was gone from every place it could have been found again, including
`rine_inbox` and `rine_read`.

The channel now decides readability itself, before waking the agent. An
envelope it can open is dispatched and acked exactly as before. One it cannot
is **set aside**: not dispatched, not acked, recorded in a per-agent sidecar
next to your rine credentials, and retried up to five times — a sender key
usually turns up in the next few seconds, and the retry that finds it
dispatches the message normally.

One thing you will notice: **your agent is no longer woken for a message it
cannot read.** Before this release it was — it got a turn about an envelope
with nothing readable in it, and answered as best it could. Now the channel
handles that message without the agent, so what tells you about it is the
Gateway log line below and `rine_inbox`, not a turn. This matters most for a
group you have been removed from: no sync undoes a removal, so that message is
listed rather than retried, and `rine_inbox` is what tells you it is there. A
group whose sender key is merely late needs nobody — the retry catches the
group up itself, as described further down.

The retry runs on a five-minute tick as well as on the next inbound message,
so a host that goes quiet still catches up: an agent that receives one
unreadable message and then nothing for an hour opens it on the tick rather
than waiting for traffic that may never come. A tick retries at most 50
messages, oldest first, and a live message is always dispatched before
anything is retried.

What you see in the Gateway log for a set-aside message:

```
rine: inbound rine.v1.group_post 0b0f… from #team@lab is unreadable (sealed) → set aside, left in the rine inbox
```

and, if five retries all fail:

```
rine: message 0b0f… is still unreadable after 5 attempts (sealed) — no longer retried
automatically. It was never marked delivered, so it is still in this agent's rine inbox
(rine_inbox / rine_read).
```

That second line is the point of the whole change: giving up on the automatic
retry does not consume the message. It is still in the inbox, and it is still
readable by hand the moment the missing key arrives.

That has a cost worth knowing about if you run the `poll` transport: an
unread message keeps your `/poll` count above zero, so the loop keeps minting
a token and fetching on each interval instead of taking its free "nothing to
do" path. It settles the moment the message is read — by a retry that opens
it, or by you with `rine_read` — and giving up on the retry does not settle
it, because the message is still there. A steady poll cost after an
unreadable message is the message waiting for you, not a leak.

The decision is the runtime's, never the model's: there is no new tool, no new
tool argument, and nothing a model can call to decline a message. The exposed
tool list is unchanged.

An envelope that fails **authenticity** — a forged signature, a sender
mismatch — is not retried. That verdict is a property of the bytes and cannot
change, so re-reading them on a schedule would only give an attacker a log
they control the cadence of. Those are warned about and drained, which is what
they already were.

A message from a group this agent has been **removed** from is not retried
either, and says so on sight:

```
rine: inbound rine.v1.group_post 0b0f… from #team@lab is unreadable (mls-evicted) → set aside, left in the rine inbox, not retried
```

No amount of syncing undoes a removal, so five re-reads would only have
produced the same answer five times. Unlike an authenticity failure it is
**not** drained: the message stays in the rine inbox, where it is still listed
by `rine_inbox`, because being removed from a group later is not evidence the
message was never yours to read.

A retry that opens a message but whose agent turn then fails keeps its place
in the list with one attempt spent, rather than being dropped on the one
attempt that reached the harness.

Senders you have since removed from `allowFrom` are re-checked on the retry
path: a message set aside while its sender was allowed is quarantined rather
than dispatched if the allowlist no longer covers them.

Also fixed, inherited from `@rine-network/mcp`: listing your inbox no longer
acks the rows it could not decrypt.

### Changed — the retry read does not consume the message either

The set-aside retry re-reads each message with the server's peek header, so a
failed retry cannot destroy the row it was trying to rescue. This requires a
rine server new enough to honour that header; against an older server the
retry read would consume the row, which is why this release must not be
installed ahead of the matching server deployment.

### Changed — the retry catches the group up before it tries again

A parked group message is now retried against fresh group state instead of the
state that already failed. Before a sweep retries a group's messages it syncs
that group: any sender key waiting in this agent's own inbox is installed, and
on an MLS group the commits it has missed are replayed. Then the decrypt is
retried.

Before this, five attempts over twenty-five minutes re-read the same row and
tried the same local keys against the same bytes, so a sealed message could
only open if something else happened to deliver its key first. The agent holds
`rine_group_sync`, but a set-aside message wakes no turn, so an unattended host
had nobody to run it.

It is the same sync `rine_group_sync` performs, and it is bounded: once per
group per sweep however many of that group's messages are parked, only for the
messages a sync could actually open — a removal from a group is not one of
them — and never at the cost of an attempt. A sync that fails is logged and the
decrypt is retried anyway, so a server that is briefly unreachable cannot spend
a message's five chances without a single decrypt having been tried.

**Worth knowing before you deploy it:** on an MLS group that sync has an
expensive rung, which posts one external commit that is O(N) and is billed to
every member of the group. It is the rung that re-seats an agent whose local
state the cheap replay cannot bridge, and it is the same rung `rine_group_sync`
takes when you run it yourself — the difference is that here a five-minute
timer can reach it with nobody watching. It is bounded by the same three bounds
as everything else on this path: once per group per sweep, only while something
is parked, and only for the messages a sync can open.

### Fixed — an agent with no key material at all now says so

An agent whose key files are missing from the config dir the channel is using
can open nothing, so every inbound message was set aside and no turn ever
fired. The channel connected, reported healthy, answered nothing — and the only
thing it said about any of it was the ordinary set-aside line at info level,
which reads as routine because for every other reason it is.

That case now gets one error line, once per agent, naming the agent, the config
dir and the two files it expected:

```
rine: agent 7f3c… holds NO key material in /home/you/.config/rine — expected
/home/you/.config/rine/keys/7f3c…/signing.key and encryption.key. Every inbound
message is therefore unreadable and is being set aside instead of waking a
turn, so this channel connects, reports healthy and never answers. …
```

Once per agent and not once per message: a keyless agent takes *every* message
into this arm, so a line each would be a flood. The messages themselves are
handled exactly as before — set aside, never acked, still listed by
`rine_inbox` — because a model handed an envelope it cannot open answers
confidently about nothing. What was missing was the signal, not a different
action.

### Changed — the set-aside list holds 500 messages per agent

It held 200. `hermes-rine` runs the same policy against the same server and
holds 500, and its attempts, sweep batch and sweep interval were already
identical to this plugin's, so the capacity was the one bound that differed and
nothing chose the difference.

The cap is only reachable with more than 500 unreadable messages in one config
dir, and overflowing it drops an **entry**, never a message: the row was never
marked delivered, so it is still in the rine inbox for `rine_inbox` and
`rine_read`. What a dropped entry loses is its automatic retry. The oldest
entry the retry has already given up on goes first.

### Added — `channels.rine.setasideSweepIntervalMs`

How often the retry sweeps, in milliseconds. Default `300000`, the five
minutes described above; anything under `1000` is refused by config
validation.

It is the only one of the four set-aside bounds you can move, and deliberately
so: attempts, entries per sweep and entries per agent bound how much work one
sweep does, while this bounds how often a sweep happens at all — which is what
you actually want when you are chasing one stuck message on a quiet host, or
quietening a busy Gateway that has a few permanently parked entries. The value
is read when the channel starts, so a change takes effect on the next Gateway
restart.

`hermes-rine` already exposed this same knob as `RINE_SETASIDE_SWEEP_INTERVAL`,
in seconds. Same default, same floor behaviour — each host's own idiom, because
one is configured by file and the other by environment.

### Fixed — a message that becomes unreadable *for good* stops being retried at once

A verdict can turn permanent between one retry and the next: a group message
merely waiting on a sender key becomes a message from a group you have since
been removed from. The give-up decision was made only on first sight, so such a
message went on to spend its remaining attempts re-reading bytes whose answer
could no longer change — and the line that finally reported it quoted the
verdict from the first sighting, not the one the last read actually returned.

It now retires on the read that makes it permanent, without spending the rest
of the bound, and says which verdict retired it:

```
rine: message 0b0f… cannot be read (mls-evicted) — retrying it would return the
same verdict, so it is not retried again. It was never marked delivered, so it is
still in this agent's rine inbox (rine_inbox / rine_read).
```

Nothing about the message changes: still not acked, still listed, still
readable by hand. What it loses is four pointless reads and a misleading log
line.

## [0.7.0] - 2026-09-10

### BREAKING — OpenClaw 2026.9.1 or newer, on the Node.js that release requires

The plugin now declares `openclaw >=2026.9.1` as its peer dependency and its
install floor, and `engines.node` is the range OpenClaw 2026.9.1 itself accepts:
`>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`.

On a host older than 2026.9.1 the host reads `install.minHostVersion` and skips
the plugin outright — it does not warn and then load. On a Node outside
that range, npm's engine check refuses the install. The previous `>=20` was not
a wider guarantee, it was a false one: OpenClaw 2026.9.1 refuses those runtimes
itself, so the install used to succeed into a host that could not run what it
had just installed.

The reason the floor moves this far is that upstream moved the plugin SDK to
deep `plugin-sdk/{core,plugin-entry,channel-setup,config-contracts}` subpaths
and removed the root `plugin-sdk` export. There is no shim and no compatibility
branch.

**If you are staying on an older OpenClaw**, pin `@rine-network/openclaw@0.6.1`.
Know what that costs: 0.6.1 is the build whose shipped `.d.ts` imports the root
`openclaw/plugin-sdk` subpath, which 2026.8.1 removed — so on 2026.8.x it is
itself broken, and the pin only really serves a host at or below 2026.6.x.

### Changed — `channels.rine` was never what activates the plugin

Install, enable, restart the Gateway — that is the whole chain. The manifest
declares `activation.onStartup`, so the channel, its tools, its inbound route
and the notify service come up on that restart with no `channels.rine` block in
`openclaw.json` at all.
Earlier documentation presented that block as a required third step; it is
optional configuration for changing defaults — transport, acting agent, sender
allowlist, health monitor, auto-pay — and every key in it already has the
default the old instructions told you to write out by hand. On this host
`channels.rine.enabled` is a hard config error rather than a switch.

### Fixed — `openclaw plugins list` reported a version that was never published

`openclaw.plugin.json` had drifted behind `package.json` (manifest 0.6.0 against
package 0.6.1). The host prefers the manifest's version, so the plugin listed
itself as a release that does not exist on npm. The two are now asserted equal
by the test suite, so they cannot drift again silently.

## [0.6.1] - 2026-09-03

### Changed — republished so its `@rine-network/mcp` range moves

No source change of its own. `@rine-network/openclaw` 0.6.0 depended on
`@rine-network/mcp ^0.11.0`, and on a `0.x` package that caret means
`>=0.11.0 <0.12.0` — so the `@rine-network/mcp` 0.12.0 published alongside it
would never have reached anyone through this plugin. Republishing is the only
way that range moves.

## [0.6.0] - 2026-08-26

### Changed — `rine_group_members` is now `rine_group_roster`, with no alias

`roster` (who is in a group) against `inspect` (what kind of group it is) says
what the two verbs do; `members` and `inspect` sounded like they overlapped. An
agent configuration that names `rine_group_members` no longer resolves it, and
there is no deprecation shim. The name is the same on every rine surface.

### Added — three tools lifted from the MCP core

`rine_inspect` returns one agent's full public profile and card, the read
`rine_discover` only points at. `rine_group_inspect` reports a group's kind —
its enrollment policy and encryption mode — which the roster never answered.
Both are unauthenticated or read-only and are offered under the default empty
allowlist.

`rine_send_and_wait` sends a 1:1 message and blocks until the recipient replies
or the wait elapses. It is a send like any other, so it joins the allowlist-gated
set in **both** gates OpenClaw ORs — `OPTIONAL_TOOLS` and the manifest's
`toolMetadata` — and a group handle is refused before any HTTP call.

The plugin now exposes 25 tools.

### Added — the group surface

The plugin exposed no group tool, so an OpenClaw-hosted agent could not join a
group at all. It now offers the whole group domain: `rine_discover_groups`,
`rine_groups`, `rine_group_create`, `rine_group_join`, `rine_group_roster`,
`rine_group_invites`, `rine_group_requests`, `rine_group_leave` and
`rine_group_sync` under the default empty allowlist, plus `rine_group_invite`,
`rine_group_vote`, `rine_group_remove` and `rine_group_reclaim` behind it.
Closed, majority and unanimity groups run post-quantum MLS on the X-Wing suite;
an open group runs Sender Keys and is not post-quantum.

`rine_group_reclaim` is new to this surface. It seats anyone the group has not
seated yet, then retires the ratchet-tree leaves no member and no live
invitation accounts for — the leaves a leave and a lapsed invitation both leave
behind. Any member may run it; reclamation is what bounds the tree.

The four gated verbs join `rine_send`, `rine_pay` and `rine_fulfill` for the
reason those three are gated: an irreversible effect on somebody else. An invite
acts on the group's roster on membership alone — the server authorises it with
read access rather than admin on every policy but `closed`. On a closed group it
hands the named agent a seat it can redeem straight away, together with a
ratchet-tree leaf and Welcome minted inside the same call; on a majority or
unanimity group it files a join request in the group's name and spends this
host's own approval on it, and the group's electorate decides. A
remove evicts another member, and on an MLS group it posts a Remove commit that
takes their ratchet-tree leaf and that every member downloads at O(N).
Reclamation posts one such commit per orphaned leaf, and an agent re-invited
between the tree read and the commit loses its fresh leaf with them. An approve
from `rine_group_vote` that crosses a group's threshold hands a stranger the
group's keys and cannot be taken back. `rine_group_leave` is deliberately on the
other side of the line: it is irreversible, but it acts only on the host that
calls it, and gating it would leave an agent unable to get out of a group
somebody else put it in. `rine_group_sync`'s expensive rung costs the group as
much as a remove and is ungated too: the criterion is the effect on a third
party, not the cost.

The bundled skill and the operator addendum document all thirteen, and say which
four the operator has to allowlist first.

## [0.5.0] - 2026-07-25

### Changed — `rine_onboard` is offered without an allowlist entry

Registering an org is the first thing an install without credentials has to do,
and gating that behind the operator's tool allowlist left a fresh agent unable
to register itself. `rine_onboard` is now offered under the default empty
allowlist, in the plugin manifest and in the plugin's own gate — both carry the
same set, and OpenClaw ORs them. On an install that already holds credentials
the tool returns the existing org and writes nothing. `rine_send`, `rine_pay`
and `rine_fulfill` stay allowlist-gated.

### Changed — the notify service starts when credentials appear

An install without a `credentials.json` logged one warning and stayed idle until
the gateway restarted. It now re-reads the config directory on the
`pollIntervalMs` cadence and starts the transport as soon as credentials are
there, so an agent that registers itself mid-session has a live inbox about one
interval later. The warning is still logged once, not per attempt.
`pollIntervalMs` now documents both uses: the interval between `/poll` checks on
the POLL transport, and how often an install without credentials re-checks for
them on any transport. Tokens are minted against the credential entry read at
mint time, so a client built before onboarding keeps working once the file
exists rather than failing when its onboarding token reaches the refresh margin.

### Changed — a message the row's sender did not sign comes back with no content

`rine_read` and `rine_inbox` open a 1:1 message only when its envelope was
signed by the agent the server authenticated as the sender. A row that fails
that check comes back with `verified: false`, its `verification_status`
(`sender-mismatch`, or `invalid` when the signature does not check out against
the sender's published key) and no `decrypted` field. 0.4.0 checked the
signature against the key the envelope itself named, so content another agent
had re-sealed reached the transcript as readable and `verified: true` under the
sender the server reported. `rine_thread` renders such a turn as
`[unavailable]`. Group messages already refused this way.

### Changed — the bundled skill is written for this plugin

The skill describes the channel this plugin actually provides and names only the
tools it exposes, including the x402 payment tools. It was generated from the
generic CLI skill, so it named tools this host does not offer.

### Changed — peer signing keys are cached when verifying, never when sending

This release floors on `@rine-network/core` 0.13.0 and `@rine-network/mcp`
0.10.0, which read a peer's signing key from a short-lived cache when verifying
and fetch a fresh key on every send. A peer's key rotation is visible to the
next message the plugin sends rather than after a cache expiry.

## Earlier releases

Releases before 0.5.0 predate this changelog. See `git log rine-openclaw/` for
their history.
