# Changelog

## 1.0.0 — 2026-10-02

First stable release. It closes eight rounds of external review of the review loop and states its invariants
explicitly. The later rounds (2026-10-02) hardened these areas:

- Read the official projection snapshot envelope without masking the keyed subscription, and deliver live review
  phases through an authenticated Connection Fetch channel scoped to one session and one call.
- Retain visible cards and reasons across delayed updates, and distinguish reviewing, observing, awaiting a
  human, allowed, denied, cancelled and unavailable. A human rejection is never rewritten as an execution
  failure by the tool result that follows it.
- Bound every probe stage with the plugin's own deadline and start it through a thunk, so an expired or
  cancelled stage never starts and the rejection of an abandoned promise is always observed — an unhandled
  rejection is a host-level failure, not a failed probe. Caller cancellation joins every stage, a handle that
  arrives after the timeout is collected, and a single probe is capped by its own slice so one probe cannot
  consume a whole review.
- Keep verification in the action's own world: when the action has an owning context that cannot serve the
  channel, the review proceeds without one instead of borrowing the plugin's scope.
- Require both sides of a filesystem observation to carry the same freshness token, and exchange directory
  listings as escaped JSON that is parsed strictly, so a filename cannot forge an entry and a failed
  enumeration is never reported as an empty directory.
- Scope the circuit breaker to the session and turn: once it trips it keeps handing every escalation to you
  until the turn resets, including review failures and answerers that were registered before it tripped, while
  `observe` never intervenes in the host's approval flow.

The invariants it states:

- **Bounded, one-step-biased review.** The reviewer answers immediately unless one concrete missing fact could
  change the verdict. At most 4 steps, 3 tool batches, 8 tool calls, 16 KiB per output and 48 KiB per review;
  the tool budgets are shared across retries and every round gets its own timeout, while the whole review stays
  bounded by the total budget.
- **Read-only, sandboxed verification.** Tools run only through a sandboxed `ctx.fs`/`ctx.shell` that advertises
  its mode and whose reported facts are checked after the fact. Reads are bounded and refuse binary content.
  The tool channel and the filesystem that decides identity, containment and subprocess paths are always taken
  from the same scope, so the object that was checked is the object that is read.
- **Opaque identity instead of paths.** `targetKey` is compared exactly, containment goes through the backend's
  `fs.contains`, the shell opens files through `fs.processPath`, and a backend that cannot answer those fails
  closed. A tool path is capped at 1024 characters.
- **Facts must still be true when the action runs.** The filesystem observations a review relied on are
  re-validated (identity, presence and the backend's freshness token) immediately before a machine approval;
  anything that changed fails closed.
- **Probes stay in their world.** In-process probes can only attest facts about the host, so they run only when
  the backend proves host access; a remote or unknown world gets no probes rather than the wrong machine's.
- **One-shot approvals.** The action fingerprint is re-checked against the live call and the session record, one
  reviewer `allow` can produce at most one machine approval, and the review card appears while the review runs.

- **Timeouts are per round, not per loop.** A round is one model call plus the tool calls it asked for, and each
  round gets its own `attemptTimeoutMs` slice (still capped by the total budget). Before this, a tool round's own
  duration was charged against the call that had to produce the verdict — measured live: the first call took 7 s,
  the tools 2 ms, and the verdict call was left 23 s of a 30 s attempt, so **every review that used a tool
  aborted and failed closed**. Each model call now also logs its own duration (`review-call`), so "why did
  reading one file take so long" has an answer in the log instead of a guess.
- **The review card now appears as soon as the review starts.** It used to render only once the session
  projection had an entry for the call, and the projection is recomputed on committed session events — of which
  there are none while a review runs (a tool-using review left the card missing for its whole 100 s). The card is
  now drawn from the escalation request itself while the call is in flight (only when the plugin's switch is on),
  and it still disappears when the call ends without the plugin having reviewed it.
- **A decided approval now updates the card.** `approval/decided` was not handled, so the card sat on
  "待审批" until the tool finished; it now moves to 已批准 / 已拒绝 as soon as the outcome is known.

- **The tool budgets are now per review, not per attempt.** The tool-call, tool-batch and total-output budgets
  live in one object created per review and are passed into every attempt, so a protocol retry no longer hands
  the model a fresh set of read allowances (three attempts used to allow 24 tool calls and 144 KiB of output,
  and that data had already reached the provider). The step budget stays per request.
- **Action-path resolution shares one absolute deadline** instead of granting each candidate its own timeout:
  a backend that ignores the abort signal can no longer turn "12 action roots" into 12 × 5 s of waiting.
- **The filesystem seam is used the way DSH defines it.** A target's `targetKey` is treated strictly as an
  opaque identity (exact string equality — never case-folded by host-OS rules, never parsed as a path),
  directory containment goes through the backend's `fs.contains(parent, child)`, and the shell channel opens
  files through `fs.processPath(target)` — never through the target key. A backend that cannot answer
  `contains`/`processPath` fails closed.
- **`read_file` no longer depends on reading a whole file**: it consumes `streamText` up to the cap (the
  backend owns UTF-8 decoding and refuses binary files) or reads one `readByteRange` window, so a large file
  yields a truncated prefix instead of `FS_TOO_LARGE` or a whole-file read.
- **The shell fallback reads a bounded window** (`FileStream.Read` of 16 KiB + 1) instead of `Get-Content -Raw`,
  so a huge target no longer gets pulled through the child process just because stdout was capped.
- **A tool path is limited to 1024 characters** (protocol error above it), so a multi-megabyte path can no
  longer enter the log or the next prompt while every byte cap stays green.
- **Every approval settlement clears its one-shot entry** (allow, mismatch and hand-off alike), so no pending
  machine-approval state survives a settlement.

- **The bounded-loop ceilings are now real ceilings under concurrency.** The tool-call quota is reserved
  before a batch runs (previously 7 used calls plus a batch of 8 executed 15), and the total tool output is
  clamped to 48 KiB *before* it is fed back to the model, with an explicit omission marker for what was cut.
- **Every tool output passes one byte-based cap** (16 KiB per output, including `list_dir`), so invalid UTF-8
  cannot inflate past the limit and no backend has to "approximately" bound itself.
- **Filesystem tools are deadline-bounded.** The abort signal now reaches `resolve` / `stat` / `listDir` /
  `readBytes`, and a host-side race guarantees the loop cannot hang on a backend that ignores it.
- **`read_file` is limited to the exact file the pending action names** (compared as real-target identity)
  instead of any file below a directory the action mentions; `list_dir` / `stat` keep root containment, and
  the real target is still refused when it looks like a credential or secret file.
- **The tool protocol is exact**: the answer must be `{"tools":[…]}` with entries carrying only `name` and
  `path`, and more than 8 tools in one batch is a protocol error (retried) rather than a silent slice.
- **The git remote probe no longer forwards credentials**: userinfo, query and fragment are stripped before
  the URL can become reviewer evidence.
- **Approval settles through one authoritative one-shot path.** The scoped fallback listener no longer
  auto-approves (it only clears stale entries and hands the request on), the agent-scoped answerer is
  one-shot even if removing the listener fails, and granting consumes the entry — so one reviewer `allow`
  can produce at most one machine approval.
- **Action fingerprints compare the full SHA-256 digest**; the short hash is only used in logs.

- **The read-only verification loop is a bounded agent with a strong one-step bias** (was: a fixed two-step
  protocol). One step remains the default path — if the evidence suffices the reviewer answers immediately —
  but when a key fact is missing it may ask for another batch of read-only tools. Every ceiling is independent
  and hard-coded: 4 steps, 3 tool batches, 8 tool calls, 16 KB per output, 48 KB total output. Hitting any of
  them ends the loop with the evidence at hand, and no verdict is still fail-closed.
- **Tool requests and verdicts now require exactly one JSON object** — no markdown fences, no surrounding
  prose, no trailing data, and two JSON objects in one answer are rejected instead of "the first one wins".
  Tool output is untrusted text, so a lenient extractor was a way to smuggle a verdict. Protocol errors throw a
  retryable error again (they had silently become a normal failed result, which skipped the retry budget).
- **A path reached through a symlink or junction can no longer cross the read boundary**: every read is
  validated lexically, then re-validated against the **real target** (realpath identity) from the host
  filesystem service, and anything that cannot be canonicalized is refused.
- **Secret and credential files are refused by name**: `.env` and its variants, `*.pem`, `*.key`, `*.p12`,
  `*.pfx`, `*.kdbx`, `*.ppk` join the existing list (SSH keys, `.npmrc`, `.git-credentials`, keychains,
  browser profiles …).
- **`read_file` is limited to files the pending action itself names**; `list_dir` and `stat` may still look at
  the workspace because they return metadata only. Paths taken from free-form `justification` or `description`
  text no longer widen the allowlist at all — free text can supply evidence, never capability.
- **The shell fallback must prove it really sandboxed the command**: the executor has to advertise a sandbox
  mode to be used at all, and after every run the facts it reports back are checked (present, read-only mode,
  no `runnerFailed`, no denial). Anything else discards the output and marks the call failed, instead of
  fabricating a `read-only` fact in the log from what we merely asked for.
- **The final grant before `allowed-once` is bound to the live call object**: the one-shot approval answerer
  re-checks the live pending action (not just the session record), and a late mismatch now follows `failMode`
  (rejected under the default `deny`) instead of quietly turning into a human approval prompt.
- **Action fingerprints cover the tool name as well as the arguments**, so "same arguments, different tool" is
  no longer reported as "the action did not change".
- The host-side local-facts layer (`collectLocalFacts`) is deleted: it read file metadata straight through the
  process filesystem, and nothing ever consumed it (probe selection only reads the command text). Reading
  metadata or content now happens only through the read-only tools, which run in the sandbox channel.

- Prompt correctness, after an audit pass over the policy text: the retained-instruction restriction paragraph
  is whole again (it had been spliced into a fragment and cut off), the duplicated
  `"reason" is required` line and a dangling `happened.` sentence are gone, and the "rationale … why an allow
  happened" sentence is complete. The text no longer promises `LOCAL_FACTS` metadata (`renderSnapshot` no
  longer emits that section either): path facts are deliberately not evidence — the host does not parse
  targets out of a command, and only the read-only probes it chooses appear in the request. Host notes now
  carry the rules only, with no environment-specific commentary; `Host notes`, `## Output contract` and the
  other invariant sentences each appear exactly once, and no two adjacent lines repeat.
- The optional self-test is described honestly: the package ships no self-test module, so with `selfTest` on
  and no `selftestModule` the log records `selftest-unavailable` and reviews are unaffected.
- The package now contains the command-line tool it documents (`tools/review-report.mjs`, plus
  `tools/inspect-session.mjs`), so an installed package can follow its own instructions.
- The `host-user-loaded` diagnostic is logged when its value changes (with a describe count) instead of once:
  the first snapshot usually arrives before the entry has settled, which made it look like the user layer
  could never be read.
- Fingerprints now hash the whole canonical form **as a stream** (O(1) memory, nothing retained)
  instead of keeping a text copy with a size cut-off. The earlier cut-off dropped an oversized chunk
  whole, so two different multi-megabyte payloads produced the same hash — the empty string's — and a
  change inside them was invisible, exactly in the "the action changed after review" property the guard
  exists for. Any change, including one in the middle of a huge argument, is now detected; `truncated`
  became a mere reporting flag for payloads over 1 MiB and `totalBytes` carries the real length. The
  node-count ceiling still returns "cannot compute", so callers keep failing closed rather than guessing.
- Budget arithmetic in the reviewer (`reviewer.js`, and the loop's own deadline checks in `verify.js`) can
  now take an injected clock, jitter and wait, and each attempt logs `review-attempt` with the timeout it
  actually received. In production the defaults are `Date.now` / `Math.random` / real timers, so behaviour
  is unchanged.
- TOCTOU guard: a fingerprint of the pending action's arguments (stable key-sorted serialization,
  16-hex-digit sha256) is frozen when the review starts and re-checked before any allow can land — at
  `tools/pre-execute`, at the `approval/request` answerer, and at the one-shot agent answerer. A mismatch
  (or a fingerprint that cannot be computed) fails closed through `failMode`, is logged as `action-changed`
  with the before/after hashes, and drops the stale one-time approval. `reviewed` now carries
  `actionFingerprint`. The fingerprint only answers "did it change" — it is never new authorization or
  updated evidence, and `critical` stays denied.
- Verdict parsing now enforces the policy's own authorization floor for `medium`: an `allow` requires
  `authorization: high` (the user explicitly named that action, target and scope), the legacy two-axis shape
  can no longer allow `medium` at all, and the prompt's examples no longer show the unsafe pairing. The `low`
  rule now names its exceptions (an absolute deny rule or a retained user restriction).
- Fixed retained-instruction accounting: a compaction checkpoint no longer counts as a retained user record,
  so dropping a real instruction can no longer be reported as complete authorization.
- Removed the file-content preview from the local-facts layer: facts are metadata only (size, kind, entries),
  and no file content is ever read for them.
- Verdicts are now stored per session, so one session's projection can never show another session's verdict
  (including when both use the same call id), and each session has its own revision.
- Approval bookkeeping requires an exact, non-empty call id: an entry without one is not stored, and a lookup
  without one consumes nothing (fail closed instead of guessing the newest entry).
- One timeout default: the config schema derives `timeoutMs` from the same constant as the runtime default.
- The audit card follows the host's escalation verdict instead of hard-coding `danger-full-access`: the host
  marks each call it reviews in this session's projection, and the card renders only for those calls.

- New `reviewConcurrency` config (1–4, default `1`) with a visible number field on the config page: the
  default keeps reviews strictly one after another, and a higher limit lets simultaneously escalated calls
  review in parallel. Calls beyond the limit queue instead of being dropped, the limit is never exceeded, and
  the queue wait is charged against that review's own budget so a queued call cannot wait forever.
- `verifyMode` now means "read-only tools during review" and ships `on`: the review prompt carries the tool
  protocol, so a review normally costs **one request** and only a review that needs facts pays a second one —
  the model asks for every tool in a single message, they run as one parallel batch, and all results return in
  one round. `off` removes the protocol from the prompt entirely. `auto` / `always` are still accepted as
  aliases for `on`, the config-page control is a two-position "Read-only tools during review", and `reviewed`
  logs `verify: { tools, steps, calls, denied? }`. Tools keep their boundaries: a sandboxed channel only
  (`ctx.fs` when it advertises `sandboxMode`, else `ctx.shell` read-only; no channel means no execution), the
  workspace and the action's paths only, credential paths refused, output fed back as untrusted data.
- `verifyMode` also accepts its text form `verifyModeText` (case-insensitive). Both keys
  are declared and volatile in the config schema, so the settings layer can store either form and a text write
  still reaches the effective value.
- Config-page controls follow one rule: a segmented control writes the normalized key (`mode` / `failMode` /
  `denyMode` / `probeRunner` / `verifyMode`), while the `*Text` form is reserved for the controls whose value
  can only travel as text (the boolean switch and the host-list box).

## 0.2.2 — 2026-09-29

- Releases publish directly from a version tag through Trusted Publishing (OIDC):
  no long-lived npm token, no one-time password, and no approval step.
## 0.2.1 — 2026-09-29

- Bilingual READMEs now link to each other at the top.
- Diagnostics: the start-up gate line is labelled as an apply-time snapshot, and every
  reviewed call records the gate value that was actually in force for that call.
- Releases are staged from a version tag through Trusted Publishing (OIDC), so no
  long-lived npm token is involved.
## 0.2.0 — 2026-09-29

**What it is.** An escalation-only reviewer for DeepSeek Harness. Ordinary work keeps running on the native
sandbox; the plugin wakes for exactly one thing — a call that asks to leave that sandbox — and returns a
verdict for that call through the host's own plumbing.

- **Codex-style policy.** Risk tier and authorization are scored separately and the pair decides
  `allow` / `deny` / `ask`. `medium` means reversible *consequences*, not a reversible artifact. System and
  security control state (`hosts`, DNS, firewall, services, certificates, `PATH`) is `high`. A safer
  alternative downgrades the action; missing records are not permission; a post-hoc approval is high risk.
  User instructions reach the reviewer as a bounded root projection (head 4 + tail 12, at most 16, dropped
  whole rather than truncated, with an explicit "evidence incomplete" marker).
- **Intervention switch, off by default.** A single segment control on the config page decides whether the
  plugin takes part at all. It is independent of permission presets, so installing it does not require
  editing a preset table.
- **Audit card.** Every reviewed call gets a line in the transcript with its verdict and the reason behind
  it, in semantic colours, expandable for the full text.
- **Fail-closed.** A review that fails or times out denies by default; consecutive denials trip a circuit
  breaker; the pending action is cross-checked against the session log before a verdict is accepted.
- **Host-side behaviour.** An allow answers the escalation approval as `allowed-once`; a denial blocks the
  tool body and returns the reason to the model. The plugin never writes session events.

**Compatibility.** Verified with DSH `0.1.7-rc.2` and `0.2.0-rc.1` on Node 24. Peer requirements are given as
ranges rather than exact pins, so a DSH upgrade does not fail the plugin compatibility check.

**Relationship to the bundled `auto` preset.** The experimental auto-review plugin registers an `auto`
permission preset, binds the session to `danger-full-access` and reviews every native call. This plugin takes
the other side of that trade: it leaves the session's sandbox tier in force and reviews only the call that
asks to escalate.

**License.** MIT. See `LICENSE`; provenance and attribution are in `NOTICE.md`.
