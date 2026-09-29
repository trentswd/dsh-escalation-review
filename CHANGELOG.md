# Changelog

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
