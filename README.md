# acpx delegation

[English](README.md) | [한국어](README.ko.md)

Ask Grok, Antigravity or Devin for help from your current Claude Code or Codex
conversation. A native worker submits the task, observes it and returns the
report while the parent can continue working. Follow up in the same external
session, recover a result later, or cancel one identified execution.

Powered by [acpx](https://github.com/openclaw/acpx). This package supplies the
`rescue` host bindings, provider settings and execution receipts. acpx owns ACP
transport, processes, queues, sessions and journals.

**Early release:** the supported providers are **Grok, agy and Devin**. Cursor and
Qoder are excluded. See [compatibility evidence](docs/compatibility.md) for the
exact tested scope and limitations.

## Install

Requirements: Node.js 22.13 or newer, npm, a host with native subagents/plugins,
and each desired provider's CLI installed and signed in. Setup does not install
provider CLIs or initiate sign-in. Only install the providers you intend to use.

For **Claude Code**:

```sh
claude plugin marketplace add WoojinAhn/acpx-delegation
claude plugin install rescue@acpx-delegation
```

For **Codex**:

```sh
codex plugin marketplace add WoojinAhn/acpx-delegation
codex plugin add rescue@acpx-delegation
```

Start a new host session to load the plugin. Ask `rescue:setup` to install the
locked runtime, then check the desired provider. For example, in Claude Code:

```text
/rescue:setup --install
/rescue:setup grok
```

Use `$rescue:setup` in Codex. The helper installs **acpx 0.22.0** from the shipped
lockfile into its own data directory, never into the host's plugin cache. Normal
commands do not download dependencies. An ACP setup check creates and closes an
empty session without submitting a prompt.

The installation command syntax was checked against Claude Code 2.1.314 and Codex
0.169.0. Package validation and live helper checks are documented separately from
host UI discovery; they are not proof of a complete installed-host interaction.

## Use from a conversation

| Task | Claude Code | Codex |
| --- | --- | --- |
| Delegate to Grok Build | `/rescue:grok` | `$rescue:grok` |
| Delegate to Antigravity | `/rescue:agy` | `$rescue:agy` |
| Delegate to Devin | `/rescue:devin` | `$rescue:devin` |
| Setup / models | `/rescue:setup`, `/rescue:models` | `$rescue:setup`, `$rescue:models` |
| Inspect / recover / cancel | `/rescue:status`, `/rescue:result`, `/rescue:cancel` | `$rescue:status`, `$rescue:result`, `$rescue:cancel` |

```text
/rescue:grok --read-only Review this change for missing edge cases.
/rescue:agy --model gemini-4-argon --effort high --background Review the spec.
/rescue:devin Implement issue #42 in this checkout.
/rescue:result exec-<id>
/rescue:grok --resume exec-<id> Recheck the corrected cancellation path.
/rescue:cancel exec-<id>
```

These are host workflow requests. The native worker invokes the helper exactly
once per task. A single task waits by default; `--background` releases the parent
after dispatch. Multi-model requests use separate fresh background workers within
host capacity. Separate sessions still share files if they use the same cwd.

Fresh work is write-capable by default. `--read-only` applies native provider
restrictions, denies unattended write approvals and adds a no-write instruction.
It is **not an OS sandbox** and does not promise shell-based tests. Creating
worktrees is outside this plugin; pass an existing worktree as the task directory.

## Models and continuation

- **agy:** choose an exact ACP model ID, or explicitly save a preference. No silent
  default or Auto choice. Its ACP catalog separates `gemini-4-argon` from the
  `high` thinking level; legacy print-mode IDs are not automatically rewritten.
- **Grok and Devin:** an explicit model or saved preference wins; otherwise the
  provider's native default is used and labelled as such.
- Explicit models and effort must be advertised and confirmed before prompting.
  There is no substitution after an unsupported choice or an uncertain result.
- Model browsing supports search and bounded pages. Browsing alone never saves a
  preference. Preferences are provider-scoped and shared between hosts.
- A follow-up inherits model, effort and access. Changing any of them requires a
  fresh execution. A missing or changed native session fails closed.

Without an explicit fresh/resume choice, the host offers the most recent eligible
execution for that provider and cwd. `--fresh` starts a separate task. A clear
follow-up can select the existing execution without another question.

## Results, timeouts and cancellation

Keep the integration execution ID from the receipt. It is different from the
native worker ID, acpx request ID and provider session ID. Completion requires a
matching, settled acpx `turn_result`; queue health or partial text is insufficient.

Workers observe in slices of up to 60 seconds, for at most 15 minutes. Observation
expiry leaves the external task running. `rescue:result` can recover retained
results later; journal loss or retention expiry is reported as unknown. A missing
submission acknowledgement is never permission to submit again.

Cancellation checks the latest execution, upstream request and settled result
under a session lock before calling acpx. It distinguishes **requested** from
**confirmed** cancellation. This guards operations through this integration;
concurrent direct acpx calls by the same OS user can bypass that lock. ACP
cancellation is cooperative.

Devin has one compatibility exception: a new empty native session cannot be
reloaded by the tested CLI. Its first prompt uses acpx's public CLI queue path,
then binds the resulting native identity. Every follow-up uses the strict shared
runtime. No hidden bootstrap prompt, vendor output parser or second supervisor is
involved. A queue acknowledgement is recorded as `queued`, not transport-accepted.

## Storage and upgrades

Receipts and preferences live under `$XDG_DATA_HOME/acpx-delegation`, or
`~/.local/share/acpx-delegation`. acpx maintains its own session and journal store.
Both hosts use the same integration data. Runtime directories include the acpx
version and shipped lockfile hash.

For development, `RESCUE_DATA_DIR` selects an isolated integration store and
`RESCUE_RUNTIME_DIR` selects an already prepared, exact-version runtime package.
These do not isolate acpx's own store; tests use unique session names and cwd.
A crashed installation/session lock is not automatically stolen: inspect the
reported operation before manually recovering that specific lock.

Upgrade the host plugin explicitly, then run setup again if its locked runtime
changed. An acpx pin does not freeze vendor CLIs or cloud behavior. Runtime pin
changes require the fixture suite and relevant live compatibility checks. Normal
use never silently updates providers or falls back to a global acpx installation.

## Development and design

```sh
npm ci --ignore-scripts --no-fund
npm test
node plugins/rescue/scripts/rescue.mjs --help
```

The tests exercise the real pinned acpx shared runtime against a controlled ACP
fixture, including strict continuation, request correlation, observation expiry,
cancellation and uncertain submission. Installer tests use an offline npm fixture.
Public-provider checks are opt-in and are not part of CI.

Work is [issue-based](https://github.com/WoojinAhn/acpx-delegation/issues).
See the [specification](docs/specification.md),
[Gemini review dispositions](docs/spec-review.md) and
[compatibility evidence](docs/compatibility.md). The
[independent implementation review](docs/implementation-review.md) records
findings, corrections and its verification limits.

This succeeds the relevant workflows in
[rescue-plugins](https://github.com/WoojinAhn/rescue-plugins), retaining Grok and agy
and adding Devin with native bindings for both hosts. Existing plugins and
historical records are not removed or imported automatically. Legacy command
spelling and internal job formats are not compatibility requirements.

MIT licensed.
