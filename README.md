# dsh-escalation-review

**English** · [简体中文](README.zh.md)

An **escalation-only LLM reviewer** for DeepSeek Harness (DSH).

Ordinary work inside the workspace — reads, writes, shell commands — runs on the native sandbox with no
review and no extra model calls. The plugin wakes for exactly one thing: a call that asks to leave the
sandbox (`sandbox_permissions` differs from the mode actually in effect). That one call gets a verdict —
allow it, refuse it, or hand it back to you — delivered through the host's own plumbing: an approval
answered as `allowed-once`, or a three-state decision object returned before the tool body runs.

Review cards retain the official session projection and its `$gate` policy entry. Live review phases
also travel over DSH's authenticated Connection Fetch channel, so a quiet session can display a review
before its next log event. A cancellable long poll reads only the addressed session and call; it opens
no separate listener. Older hosts without this capability retain the projection and neutral pending copy.
Review reasons are held in memory and may be unavailable after a host restart.

## A Codex-style reviewer

The policy follows OpenAI's Codex guardian template
(`codex-rs/prompts/templates/guardian/policy_template.md`), and that is where most of the work went.

- **Three-axis contract.** Risk tier and authorization are scored separately, and the pair decides
  `allow` / `deny` / `ask`. Authorization is re-derived on every escalation: a past approval counts only
  while its evidence is still in the session.
- **`medium` means reversible consequences, not a reversible artifact.** A step is medium only when its
  blast radius is bounded *and* what it does can be undone. Editing a file back is not recalling its effect.
  A `medium` verdict may only come out as `allow` when authorization is `high` — the user explicitly named or
  approved *that* action, target and scope; "they approved the substance" is not enough, and the output parser
  rejects it outright.
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
| Three denials in a row, or 10 within 50 calls | Circuit breaker: it stops refusing and hands the call to you instead — and it stays that way for the rest of that turn, so review failures and answerers registered before it tripped also go to you. A new turn starts clean; `observe` never intervenes. |
| Pending action disagrees with its logged tool call | The review stops rather than judge evidence it cannot verify. |
| Pending action changes after it was reviewed | Every allow is re-checked against a fingerprint frozen at review time; a mismatch fails closed (`failMode`) and is logged as `action-changed`, so the action that runs is always the action that was reviewed. |

Reviews are queued by `reviewConcurrency` (default `1`, at most `4`): with the default they run strictly one
after another, and above it escalations review in parallel while anything past the limit waits — a waiting
call is never dropped, and the time it waited is charged against that review's own budget.

The reviewed action is the executed action. The plugin freezes a fingerprint of the pending action when the
review starts and re-checks it before any allow can land — including before the approval is answered on your
behalf. If the action changed (or cannot be fingerprinted at all), the allow is refused and `failMode` decides
whether the call is blocked or handed back to you.

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
dsh plugin --profile <profile-name> add dsh-escalation-review        # from npm
dsh plugin --profile <profile-name> add D:\path\to\plugins\escalation-review   # from a checkout
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
| `reviewConcurrency` | `1` | How many reviews may run at once (1–4). `1` keeps them strictly one after another; above the limit a call queues — nothing is dropped and the limit is never exceeded, and the queue time is charged against that review's total budget. |
| `verifyMode` | `on` | Whether the reviewer may use read-only tools: `on` (default) or `off`. `auto` / `always` are accepted as aliases for `on`. See [Read-only tools during review](#read-only-tools-during-review). |
| `verifyModeText` | `""` | Text form of `verifyMode` (`"off"` / `"on"`, plus the `auto` / `always` aliases); non-empty overrides `verifyMode`. |
| `probeRunner` | `shell` | Read-only probes: `shell` (a read-only command in the pending action execution world; default) or `inproc` (filesystem-class probes only, and only when that world is provable). |
| `policyExtra` | `""` | Rules you write yourself and append to the reviewer policy (the same explicit route as Codex's `auto_review.extra_policy`). This is the way to change how the reviewer judges. |
| `allowedHosts` | `[]` | Hosts whose ordinary network access counts as low risk. An empty array in a user file **overrides** the package list, so write the full list if you write the key at all. |
| `allowedHostsText` | `""` | Text form of `allowedHosts` (comma or newline separated) written by the config page; non-empty overrides `allowedHosts`. |
| `timeoutMs` | `100000` | Total budget for one review, retries included. |
| `attemptTimeoutMs` | `30000` | Cap for **one round** (one model call plus that round's tools); a round that times out is retried. The whole review stays bounded by `timeoutMs`. |
| `retryDelayMs` | `5000` | Wait between attempts. |
| `minAttemptMs` | `2000` | Skip a retry when the remaining budget after the delay is below this. |

## Read-only tools during review

A review is normally **one request**: the reviewer reads the evidence and returns its verdict. `verifyMode`
decides whether it may also check facts, and it ships **on**:

- `on` (default) — the model may ask for read-only tools before deciding;
- `off` — no tools at all (the tool protocol is not even in the prompt, so the review is one request).

`auto` and `always` are accepted as aliases for `on`, so older configurations keep working.

This is a bounded small loop, **not** a subagent: it runs in this process, opens no session, writes nothing, injects
no workspace instructions, and cannot wander. **One step is the default path**: if the evidence suffices it answers
immediately. When a fact is missing the model asks for **all of its tools in one message**
(`{"tools":[{"name":"read_file","path":"…"}, …]}`), the tools run **as one batch, in parallel**, every result comes
back in a single round, and the next request prefers to answer. So a review costs **one request** normally and
**2–4** when it needs facts. The ceilings are independent and hard-coded (**4 steps / 3 batches / 8 tool calls /
16KB per output / 48KB total / 1024 characters per path**). The tool-call, tool-batch and output budgets are
shared by the whole review — retries do not reset them — while the step budget is per request. "One tool per
step" is impossible and there is no wandering: hitting any ceiling ends the loop with the evidence at hand, and
no verdict means fail-closed.

They see only what the review is allowed to see: the tools run **inside a read-only sandbox** (the executor must
advertise a sandbox mode, and the facts it reports back are checked), `read_file` is limited to the **exact file
the pending action names** (compared as the DSH opaque target identity — no path parsing, no host-side
case-folding), `list_dir`/`stat` containment is decided by the backend's own `fs.contains()`, and credential or
secret paths (`.credentials*`, SSH keys, keychains, `.npmrc`, `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`) are
refused. Binary files, a missing `processPath`/`contains` capability, and anything unverifiable fail closed.

| Tool | Reads | Bound |
|---|---|---|
| `read_file` | a text file | 16 KB, truncated with a marker |
| `list_dir` | a directory | at most 200 entries, with the remainder counted |
| `stat` | existence, type, size | metadata only |

They have **no write path**, and they never run with the plugin's own host privileges:

- preferred: `ctx.fs`, but only when it is the sandbox-enforcing backend (it advertises `sandboxMode`);
- otherwise: `ctx.shell` with `sandboxPolicy: { mode: 'read-only', workspaceRoot }`, whose `run.sandbox` reports
  the sandbox facts that actually applied;
- **no channel at all: no tool runs** (`verify.denied = 'no-sandbox'` in the log) — never a non-sandboxed read.

Paths are allow-listed by this plugin (the sandbox only guarantees the write boundary): the workspace and paths
named in the pending action are readable; credential paths (`~/.dsh/.credentials*`, SSH keys, keychains, browser
profiles, `.npmrc`, `.git-credentials`) are refused and logged. Tool output is fed back as **data** — explicitly
marked as untrusted, never as instructions or authorization — and the verdict still comes from the same strict
protocol, so `critical` stays denied and a parse failure still fails closed. If the loop runs out of budget or
steps without a verdict, nothing is guessed: the review fails and your `failMode` decides (`ask` hands it back to
you). Every review logs what the tools did — `verify: { tools: 'on'|'off', steps, calls: [{name, path, ms, bytes,
sandbox}], denied? }` — including the observed sandbox facts, so "it really ran sandboxed" is checkable later.

## What it does, and what it does not do

**It answers escalations for you.** With the switch on, an allow verdict is delivered as an approval
answered `allowed-once`: that one call runs outside the sandbox with no prompt. This is the capability and
the risk in one — you are trading "I read this one myself" for "a model read it".

**It sends evidence to your model provider.** The pending action, the session context, the bounded
instruction projection and the host's own read-only probe results go into one review request through the
provider configured in DSH (or the one you pick in the card). Reviews cost tokens. Path facts are **not**
part of that request: the host does not parse targets out of the command (doing so would silently miss
targets, which is the opposite of failing closed), so what you see is the action itself plus the probe
results the host chose to run.

**It keeps a local log.** `~/.dsh/escalation-review.log` holds one JSON object per line, including the
command text and the verdict with its reason. Treat it as sensitive as the sessions it summarises.

**It never writes session events.** Verdicts and reasons are delivered in memory and to the audit card, so
session history stays exactly as the host wrote it.

**Failures close, and repeated denials break the loop.** Timeout, malformed JSON, a provider error or a
failed cross-check end in `deny` by default; three denials in a row, or ten within fifty calls, trip the
breaker, and from then on every escalation in that turn goes to you.

**Every decision is cross-checked** against the logged tool call, so a verdict is only issued on evidence
the plugin can tie to the call it is about.

## Logging and evidence

- Internal packages resolve from the running app first (`app.asar/dsh`) and the profile second, so an app
  upgrade keeps the plugin on the app's own copies. The root used is recorded in the `assembler-resolved`
  log line.
- Read-only probes run in-process by default (nothing spawned). With `probeRunner: shell` they run as a
  read-only command inside the sandbox, roughly 650–700 ms each; the budget is at most 4 probes, 3 seconds
  in total, 1.2 seconds each, 2 KB of output. A single probe is additionally capped by its own slice, so one
  slow probe cannot consume the whole review. Each stage has the plugin's own deadline as well as the
  caller's cancellation, and if the sandbox shell is unavailable the probes are reported as unavailable
  rather than falling back to the host's own in-process channel.
- Review log: `$DSH_HOME/escalation-review.log`, one JSON object per line. `tools/review-report.mjs`
  renders it plus the matching session context into Markdown. Key events: `ready`,
  `intervention-gate`, `config-effective`, `assembler-resolved`, `reviewed`, `reviewer-failed`,
  `review-attempt` (the timeout each attempt actually received), `review-retry`, `review-retry-skipped`,
  `approval-granted`, `action-changed`, `circuit-breaker`, `projection-registered`.
  `reviewed` carries `actionFingerprint` (a 16-hex-digit hash of the reviewed arguments — never the
  arguments themselves), and `action-changed` records the before/after hashes when an allow was refused
  because the pending action moved under it. `selftest-summary` appears only when a self-test module was
  configured: the package ships none, so with `selfTest` on and no `selftestModule` the log says
  `selftest-unavailable` instead and reviews are unaffected.

## The audit card

An escalation appears in the transcript as a review card carrying the status and the reason. Clicking it
expands the detail. The status follows what the host can actually prove about **that** call:

| Status | When |
|---|---|
| Reviewing (`审批中`) | The plugin is deciding, and the host states that it will answer automatically. |
| Observing (`评审中`) | `mode: observe` — the plugin reviews and records, but never answers. |
| Awaiting a human (`待审批`) | The host states it will **not** answer automatically (`denyMode: ask`, a tripped breaker), or the plugin hands the call back. |
| Escalation request | The call is escalation-shaped but the review is not confirmed yet — a neutral state, never a claim. |
| Allowed (`已放行`) / Denied (`已拒绝`) | The verdict that was applied. |
| Cancelled (`已取消`) / Approval unavailable (`审批不可用`) | The host cancelled the call, or the plugin could not answer it. |
| Executed with a tool error (`已执行（工具报错）`) | The call was allowed and the tool itself failed. A human rejection is never rewritten as this. |

Status colours come from the official theme tokens. A card that has a verdict entry for the call stays visible;
a merely provisional one is retracted when the host reports that the switch is off or that the call is not an
escalation.

The card reads the host's per-call facts from the session projection **and** from an authenticated Connection
Fetch route scoped to one session and one call — the projection is recomputed on committed session events, of
which a review in flight produces none, so the live route carries the phase while the review runs.

Known limitation: an **allow** reason travels in memory (the projection plus that live route), because approval
outcomes have no reason field of their own. After a session is reloaded, older calls keep their status and lose
that reason; new reviews are unaffected.

Everything runs through documented extension points: `tools/pre-execute`, `approval/request`,
`sessionProjections`, the Connection Fetch registry, `conversation.chat.node`, `configForms`.

## License

MIT. See [LICENSE](LICENSE). Third-party attributions, and the measured text overlap with the projects this
policy borrows from, are recorded in [NOTICE.md](NOTICE.md).
