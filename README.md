# acpx delegation

On-demand coding-agent delegation from Claude Code and Codex, powered by
[acpx](https://github.com/openclaw/acpx).

Ask Grok, Antigravity or Devin for help from your current conversation.
A native host worker handles the external request while you continue working,
then returns the result. Follow-up, result recovery and cancellation retain the
identity of the selected execution.

**Status: implementation in progress.** The specification is being reviewed with
Gemini before runtime implementation. Provider support below is the target scope,
not a claim that live compatibility has already passed.

| Provider | Claude Code entrypoint | Codex entrypoint |
| --- | --- | --- |
| Grok Build | `/rescue:grok` | `$rescue:grok` |
| Antigravity | `/rescue:agy` | `$rescue:agy` |
| Devin | `/rescue:devin` | `$rescue:devin` |

Shared operations are `/rescue:setup`, `/rescue:models`, `/rescue:status`,
`/rescue:result` and `/rescue:cancel` (use `$` instead of `/` in Codex).

The host schedules workers and gathers reports. acpx owns external execution,
sessions, queues and journals. This package supplies host instructions and the
minimum validation needed to preserve model, access and session choices.

## Development

Work is tracked in [GitHub issues](https://github.com/WoojinAhn/acpx-delegation/issues).
The [specification](docs/specification.md) defines supported workflows, acceptance
criteria and known integration questions. Installation and validated examples
will be added with the implementation.

## Migration scope

This project succeeds the relevant workflows in
[rescue-plugins](https://github.com/WoojinAhn/rescue-plugins). It retains Grok,
Antigravity, adds Devin, and provides native bindings for both hosts.
Cursor and Qoder are outside this package's scope. Existing plugins and historical records
are not removed or imported automatically.

Read-only behavior depends on the provider and is not an OS sandbox guarantee.
Stopping observation does not cancel work. acpx and external CLI versions are
validated as a combination; a pinned acpx release does not freeze cloud services.
