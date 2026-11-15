# Compatibility evidence

Validation date: 2026-11-16. This is an evidence record, not a guarantee that a
vendor update or a different account behaves identically.

## Runtime and provider versions

| Component | Tested version |
| --- | --- |
| acpx | 0.22.0, exact dependency and shipped lockfile |
| Node.js | 26.13.0 locally; Node 22 is the CI target |
| Grok Build | 1.0.77 (50ca579fa996) |
| Antigravity CLI | 1.5.9 |
| Devin CLI | 3000.12.57 (96542e930752) |
| Claude Code manifest validator / CLI help | 2.1.314 |
| Codex CLI help | 0.169.0 |

## Live provider checks

The helper used an isolated integration data directory and a temporary task cwd.
The tests used the installed CLIs and their existing authenticated accounts.
Each setup/model probe created an empty ACP session without inference. Task
prompts requested fixed markers or bounded capability checks; no project source
was delegated for modification.

| Capability | Grok | agy | Devin |
| --- | --- | --- | --- |
| ACP startup and cached authentication | Verified live | Verified live | Verified live |
| Fresh prompt and correlated settled result | Verified live | Verified live | Verified live through fresh CLI queue path |
| Exact model | Exact `grok-4.7` confirmed | `gemini-4-argon` + `high` confirmed | `swe-2-high` + `high`; `swe-2-flash-medium` confirmed |
| Read-only provider configuration | `plan` startup verified | `plan` confirmed | `ask` retained after empty-session recovery |
| File reading in read-only mode | Marker read live | Marker read live | Marker read live |
| Same-native-session continuation | Verified live | Verified live | Verified live |
| Explicit active cancellation | Settled `cancelled` live | Settled `cancelled` live | Settled `cancelled` live |

Read-only tests confirm the requested controls and file-reading path. They do not
prove universal write isolation, hostile-prompt resistance or an OS sandbox.
The controlled fixture tests cover protocol state transitions; vendor write-tool
permission denial is not independently tested. Write-capable execution is
configured but a live source-editing task is not part of this release check.

## Devin first-request behavior

The tested Devin CLI does not persist an empty native session before its first
prompt. Shared-runtime strict continuation correctly rejects reloading it. The
first request therefore uses acpx's public CLI and records its queue receipt;
the final native identity is bound only after a correlated settled result.

An initial integration probe exposed an acpx 0.22.0 interaction: re-supplying
`--model` on that CLI prompt caused model replacement to skip saved configuration
replay, including `mode=ask`. The final adapter selects and verifies the exact
model at creation and does not select it again during submission. Requested
mode/effort are explicitly saved even when already current. A live controlled
comparison confirmed that this preserves the selected model and read-only mode.
Continuation still uses the strict shared runtime and never this recovery path.

## Fixture and packaging checks

Local complete suite: `npm test` — **31 passed, 0 failed** (Node 26.13.0).

- Real pinned acpx with a controlled ACP agent: request/result correlation,
  cross-process recovery, observation expiry, warm/cold strict continuation,
  model/access mismatch, targeted cancellation, concurrent admission, uncertain
  launch and finite setup cleanup.
- Empty-session fixture: CLI queue acknowledgement, unknown acknowledgement,
  provisional identity, terminal-result preservation on binding failure,
  bootstrap cancellation and strict follow-up.
  The production configuration/submission adapters are exercised directly,
  including preservation of a non-default model, ask mode and high effort.
- Offline installer fixtures: exact pin and lock hash, atomic setup, concurrent
  installation, immutable package cache and no global dependency fallback.
- Host packaging: manifests, command/skill inventories, relative references and
  shipped runtime files. All eight native Codex skills passed the skill validator.
  Claude plugin and marketplace passed its strict native manifest validator.
- A real `setup --install` downloaded and loaded the shipped locked runtime in
  isolated integration storage. No existing host configuration was modified.

A complete installed Claude/Codex interaction, native worker scheduling and host
UI command discovery were not exercised. Command syntax was checked against the
installed host help; package discovery is supported by manifest/path validation.
The native-worker lifecycle is a host instruction contract, not a second runtime.

## Maintenance boundary

Re-run the fixture suite when changing the acpx pin. Re-run the affected live
cells when changing provider startup, model, permission or continuation behavior.
A version pin freezes neither provider binaries nor cloud APIs. Keep unverified
cells visible instead of treating one successful prompt as provider parity.
