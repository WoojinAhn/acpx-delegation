# Delegate one task

The entrypoint supplies the provider and host binding. Providers are `grok`, `agy`
and `devin`; do not route Cursor or Qoder to a different provider silently.

1. Resolve the task cwd and prompt. If the request lacks a task, ask for it. Locate
   the installed helper and run `--help` if its command contract is not loaded.
   A missing runtime requires explicit `setup --install`; never install a vendor CLI
   or initiate login automatically.
2. Honor explicit fresh/resume choices. Otherwise use `candidate PROVIDER --cwd CWD`.
   Offer continuation or a fresh session when an eligible candidate exists. No
   candidate means fresh. A clear user follow-up settles the continuation choice.
   Never reuse an unrelated repository's receipt.
3. Select the model using [models.md](models.md). An exact ID is passed unchanged,
   never split on commas. ACP model IDs may differ from a vendor's print-mode IDs.
   In agy, for example, a model and its advertised thinking level are separate
   selections. Use the returned model ID and `--effort` value; do not manufacture
   a combined ID. Resume inherits unchanged model/effort/access; changing them
   requires a new execution and is never done silently.
4. Fresh access is write-capable. Use `--read-only` when the user asks for no edits;
   do not infer it merely from investigation wording. Read-only applies provider
   restrictions and denied write approvals, not an OS sandbox. Do not promise
   terminal tests in this mode. Worktree creation is unsupported; use an existing
   worktree as cwd or report the limitation before launch.
5. Resolve delivery: a single task waits by default; `--background` returns after
   native-worker dispatch. Multiple selected models always get independent fresh
   background workers. Reject conflicting multi-model resume/wait or simultaneous
   wait/background choices. Parallel sessions share files unless cwd differs.
6. Write the original prompt into a private UTF-8 temporary file using a file tool.
   Never interpolate it into shell syntax. Dispatch one native worker per resolved
   execution with that file, provider, cwd, exact options and the installed
   [worker contract](worker.md). Only that worker calls `start`.

For background delivery, return after dispatch without polling the task. Name each
worker, any received execution ID, and the host's `rescue:status`/`rescue:result`
paths. Dispatched, transport-accepted and completed are different states. If host
capacity is exhausted, keep the unstarted work visible; never duplicate uncertain
work or create a persistent scheduler.

For wait delivery, collect the worker's settled result or explicit incomplete
observation. Preserve errors, partial reports, unknown outcomes, permission denials
and requested/reported model differences. Do not retry automatically or switch
providers/models to make an error disappear. Stopping a worker does not cancel
the external task; explicit `rescue:cancel` does.
