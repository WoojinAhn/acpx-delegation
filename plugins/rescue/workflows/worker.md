# Native execution worker

Run only the supplied task through the installed helper. Do not select a model,
ask questions, perform the task yourself, delegate further, or modify the choices.
The native worker's model and the external model are different.

1. Copy the supplied prompt file byte-for-byte into a private unique temporary
   directory with a filesystem tool. Never put task text into shell syntax or argv.
2. Run exactly once in the target cwd:
   `node <plugin-root>/scripts/rescue.mjs start PROVIDER --cwd CWD --prompt-file FILE`
   with the resolved `--model`, `--effort`, access and fresh/resume options. Each
   value is a separately quoted argument. Do not pass delivery flags to `start`.
3. Retain the execution `id`, request/session identities and observation deadline.
   Send the receipt to the parent if supported. A malformed/missing receipt makes
   launch uncertain: report it and inspect status, never repeat `start`.
   Delete only the worker's temporary prompt after a complete receipt; leave the
   user-supplied original untouched.
4. Call `wait ID --cwd CWD --timeout-ms 60000`. If the shell tool yields a running
   process, resume that process before starting another observation. Never overlap
   waits. Pending means repeat with the same ID; the original 15-minute deadline
   does not reset. Expired/unknown means return an incomplete result, not failure
   or permission to restart. Accepted work keeps running after observation ends.
5. Return the complete report, terminal result or explicit observation limitation,
   requested/reported model, execution ID and resume/cancel hints. Do not label
   partial text or a healthy queue owner as completed work.

Follow the same lifecycle for parent background delivery. The worker keeps
observing after its receipt; stopping a native worker is not external cancellation.
