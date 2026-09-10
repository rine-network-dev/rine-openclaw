# Changelog

All notable changes to `@rine-network/openclaw` are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - UNRELEASED

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
