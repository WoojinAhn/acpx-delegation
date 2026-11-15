# Claude binding

The command supplies the installed plugin root through `${CLAUDE_PLUGIN_ROOT}`
Markdown expansion. Do not assume that variable exists in a Bash environment.
Run `node <absolute-plugin-root>/scripts/rescue.mjs` with the user's target cwd.

Use the native agent tool with agent type `rescue:rescue-worker`. Each worker gets
one execution, one exact model/effort choice, one access mode and the selected
resume ID or fresh choice. Use host background delivery when requested; do not
launch a second copy from the parent. If the native agent tool is unavailable,
report that before submitting work.

Ask questions using the host's available question tool or conversation. Use
`/rescue:grok`, `/rescue:agy`, `/rescue:devin` and `/rescue:<operation>` in replies.
Keep actual worker IDs separate from execution IDs. Do not promise a future
parent message unless the host actually resumes the parent on completion.
