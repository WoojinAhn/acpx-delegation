# Codex binding

Resolve the installed plugin root as `../../` from the loaded
`codex-skills/<name>/SKILL.md`. Run `node <absolute-plugin-root>/scripts/rescue.mjs`
with the user's target cwd; the plugin path is not the working repository.

Use the available native spawn-agent tool, with the host's default worker model.
The external provider's model is a helper argument, not a native worker override.
Supply `workflows/worker.md`, the absolute helper path, task cwd, prompt-file path,
and one resolved model/access/session choice. Do not run Claude Code as a bridge.
If native workers are unavailable, report that before submitting a task.

Use native question tools where available, otherwise ask in conversation. An
unanswered required choice is not permission to choose a model or resume target.
Use `$rescue:grok`, `$rescue:agy`, `$rescue:devin` and `$rescue:<operation>` in replies.
Native completion may update the worker without generating a later parent answer;
provide an execution ID and result lookup path instead of promising a notification.
