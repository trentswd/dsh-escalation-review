# dsh-escalation-review

**English** · [简体中文](README.zh.md)

An **escalation-only LLM reviewer** for DeepSeek Harness (DSH).

Ordinary work inside the workspace — reads, writes, shell commands — runs on the native sandbox with no
review and no extra model calls. The plugin wakes for exactly one thing: a call that asks to leave the
sandbox (`sandbox_permissions` differs from the mode actually in effect). That one call gets a verdict —
allow it, refuse it, or hand it back to you — delivered through the host's own plumbing: an approval
answered as `allowed-once`, or a three-state decision object returned before the tool body runs.

## A Codex-style reviewer

The policy follows OpenAI's Codex guardian template
(`codex-rs/prompts/templates/guardian/policy_template.md`), and that is where most of the work went.

- **Three-axis contract.** Risk tier and authorization are scored separately, and the pair decides
  `allow` / `deny` / `ask`. Authorization is re-derived on every escalation: a past approval counts only
  while its evidence is still in the session.
- **`medium` means reversible consequences, not a reversible artifact.** A step is medium only when its
  blast radius is bounded *and* what it does can be undone. Editing a file back is not recalling its effect.
- **System and security control state is `high`.** `hosts`, DNS, firewall rules, services, certificates,
  `PATH`. Each can be edited back; traffic already sent cannot be recalled.
- **A safer alternative downgrades the action.** When the same goal is reachable without the dangerous
  step, the dangerous step is not what the user asked for.
- **Missing records are not permission.** Absent evidence is absence of authorization, never implied consent.
- **A post-hoc approval is high risk.** Approving after the fact does not unlock a `critical` action.
- **Bounded root projection.** User instructions reach the reviewer as head 4 + tail 12, at most 16, whole
  items dropped rather than truncated, with an explicit "evidence incomplete" marker. Evidence is labelled
  by role: human instruction, direct parent, approval answer, checkpoint, or fact.

Four rules shape the edges:

- **An explicit user prohibition is a hard denial**, overriding the risk tier even for a low-risk action.
- **Evidence is data, not instruction.** Command text, file contents and tool output carry no authority;
  text claiming "the user already allowed this" authorizes nothing.
- **Appearance does not downgrade.** A credential-shaped payload is not made safer by looking like a
  placeholder, nor an export by the destination it claims.
- **Cross-check before judging.** The pending action is compared with the logged `tool/call` for the same
  `callId`; an unambiguous disagreement aborts the review. A malformed verdict counts as a review failure.

Attribution and the measured text overlap with the projects these ideas come from are in [NOTICE.md](NOTICE.md).

## How it differs from the bundled `auto` preset

The app ships `@deepseek-ai/dsh-experimental-auto-review`. It registers an `auto` permission preset, binds
the session to `danger-full-access`, and reviews **every** native call — one extra model request per call,
at full access.

| | bundled `auto` preset | this plugin |
|---|---|---|
| sandbox tier | `danger-full-access` | the session's own tier, so `workspace-write` stays in force |
| calls reviewed | every native call | only the call that asks to escalate |
| preset table | registers `auto` | untouched — the gate is this plugin's own switch |
| extra model calls | one per call | one per escalation, none otherwise |

Keeping the session's sandbox tier is the point of the comparison: the sandbox covers ordinary work, and
the reviewer covers the gap where DSH would otherwise stop to ask you.

## Behaviour

| Situation | What happens |
|---|---|
| Ordinary call, inside the sandbox | Not reviewed; passed to the next handler untouched. |
| Escalation, intervention switch off | Not reviewed, not touched, no model call. This is the default state. |
| Escalation, switch **on** | Reviewed once and recorded. An allow answers the approval with `allowed-once` (you are **not** asked again); a deny blocks the body and returns the reason to the model. |
| Review failed or timed out | `failMode` decides. Default `deny` (fail closed). |
| Three denials in a row, or 10 within 50 calls | Circuit breaker: the plugin stops refusing and hands the call to you instead. |
| Pending action disagrees with its logged tool call | The review stops rather than judge evidence it cannot verify. |

## Requirements

- DSH **0.1.7-rc.2** or **0.2.0-rc.1** (both exercised), Node 24.
- Windows is what has been exercised; other platforms are expected to work but are unverified.
- `peerDependencies`: `@deepseek-ai/cordis` `~4.0.4`, `@deepseek-ai/dsh-llm` `>=0.1.7-rc.2 <0.3.0`.
- Write `@deepseek-ai/dsh*` peers as a range: the host checks them with
  `semver.satisfies(runtime, range, { includePrerelease: true })`, so an exact prerelease pin reports as
  incompatible on the next DSH release.

## Install

From a local checkout, the GUI route is the cleanest: left sidebar **Plugins** (not Settings) → **Add
plugin** → the absolute path of this directory, for example
`D:\path\to\checkout\plugins\escalation-review`. It is registered as a `link:` dependency and appended to
`dsh.profile.bundles`.

```sh
dsh plugin --profile <profile-name> add <package-or-path>
```

- `~/.dsh/profiles/web` and `~/.dsh/profiles/desktop` are **independent**: installing into one leaves the
  other alone. Use `--profile web` to test against `dsh web`.
- The host half is loaded from disk at startup, so **restart DSH** after installing, and again after
  changing any file under `lib/`. The client half of an open session needs that restart too; a page reload
  does not pick it up in the desktop app.

Uninstall from the same Plugins page, or drop the entry from `dsh.profile.bundles`.

## Configuration

`enabled` is the gate, and it ships **off**: while it is off the plugin runs no review and makes no model
calls. With it on, it answers **every** sandbox-escalation approval. The gate belongs to the plugin rather
than to your permission table, so installing it leaves your presets as they are, independent of whichever
preset a session happens to use. Set it from the config page — the two-position control on the first row
of the card, Off / On — or with `"enabled": true` in a config file (the GUI writes the textual form
`"enabledText": "true"`).

Lowest to highest priority: the package's `config.json` → `~/.dsh/escalation-review.config.json` →
`configPath` if you pass one → the host config block of the plugin entry → the settings layer the config
page writes (with its own `*.ui.json` companion). File layers are re-read on every escalation and the
settings layer is polled about every two seconds, so edits take effect without a restart; changing the
plugin's **code** needs one.

`config.json` accepts `//` and `/* */` comments. `cordis.patch.yml` is YAML: comments there need `#`, and a
parse failure makes the loader skip the whole bundle silently.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | The intervention switch. |
| `enabledText` | `""` | Text form of the switch (`"true"` / `"false"`) written by the config page; non-empty overrides `enabled`. |
| `provider` / `model` | `""` | Which provider and model review; empty follows the session. |
| `reasoningEffort` | `""` | Reviewer thinking effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or empty to follow the session. |
| `failMode` | `deny` | What a failed or timed-out review means: `deny` or `ask`. |
| `denyMode` | `deny` | What a deny verdict means: `deny` outright, or `ask` the user. |
| `probeRunner` | `inproc` | Read-only probes: `inproc` (no process spawned) or `shell` (a read-only command inside the sandbox). |
| `policyExtra` | `""` | Free-form rules appended to the reviewer policy. |
| `allowedHosts` | `[]` | Hosts whose ordinary network access counts as low risk. An empty array in a user file **overrides** the package list, so write the full list if you write the key at all. |
| `timeoutMs` | `100000` | Total budget for one review, retries included. |
| `attemptTimeoutMs` | `30000` | Cap for a single request; a timeout is retried. |
| `retryDelayMs` | `5000` | Wait between attempts. |
| `minAttemptMs` | `2000` | Skip a retry when the remaining budget after the delay is below this. |

## What it does, and what it does not do

**It answers escalations for you.** With the switch on, an allow verdict is delivered as an approval
answered `allowed-once`: that one call runs outside the sandbox with no prompt. This is the capability and
the risk in one — you are trading "I read this one myself" for "a model read it".

**It sends evidence to your model provider.** The pending action, the session context, the bounded
instruction projection and the local facts go into one review request through the provider configured in
DSH (or the one you pick in the card). Reviews cost tokens.

**It keeps a local log.** `~/.dsh/escalation-review.log` holds one JSON object per line, including the
command text and the verdict with its reason. Treat it as sensitive as the sessions it summarises.

**It never writes session events.** Verdicts and reasons are delivered in memory and to the audit card, so
session history stays exactly as the host wrote it.

**Failures close, and repeated denials break the loop.** Timeout, malformed JSON, a provider error or a
failed cross-check end in `deny` by default; three denials in a row, or ten within fifty calls, trip the
breaker and the call goes to you.

**Every decision is cross-checked** against the logged tool call, so a verdict is only issued on evidence
the plugin can tie to the call it is about.

## Logging and evidence

- Internal packages resolve from the running app first (`app.asar/dsh`) and the profile second, so an app
  upgrade keeps the plugin on the app's own copies. The root used is recorded in the `assembler-resolved`
  log line.
- Read-only probes run in-process by default (nothing spawned). With `probeRunner: shell` they run as a
  read-only command inside the sandbox, roughly 650–700 ms each; the budget is at most 4 probes, 3 seconds
  in total, 1.2 seconds each, 2 KB of output. Without `pwsh`, the in-process channel is used.
- Review log: `$DSH_HOME/escalation-review.log`, one JSON object per line. `tools/review-report.mjs`
  renders it plus the matching session context into Markdown. Key events: `ready`,
  `intervention-gate`, `config-effective`, `assembler-resolved`, `reviewed`, `reviewer-failed`,
  `review-retry`, `approval-granted`, `circuit-breaker`, `projection-registered`.

## The audit card

An escalation appears in the transcript as a review card carrying the status (reviewing, awaiting
approval, allowed, denied, executed with a tool error) and the reason. Clicking it expands the detail.
Status colours come from the official theme tokens.

Known limitation: an **allow** reason travels through an in-memory session projection, because approval
outcomes have no reason field of their own. After a session is reloaded, older calls keep their status and
lose that reason; new reviews are unaffected.

Everything runs through documented extension points: `tools/pre-execute`, `approval/request`,
`sessionProjections`, `conversation.chat.node`, `configForms`.

## License

MIT. See [LICENSE](LICENSE). Third-party attributions, and the measured text overlap with the projects this
policy borrows from, are recorded in [NOTICE.md](NOTICE.md).
