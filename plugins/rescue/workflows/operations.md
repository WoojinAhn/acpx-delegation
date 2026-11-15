# Operations

Use the installed helper in the user's target cwd. These operations run inline;
they do not create native workers or submit inference tasks.

- **setup:** `setup --install` explicitly installs the pinned runtime into its data
  directory. `setup PROVIDER` checks ACP/authentication without a prompt. Report
  errors and user-driven sign-in instructions; do not initiate OAuth or update
  a vendor CLI. A missing runtime alone is not proof the provider is logged out.
- **models:** follow [models.md](models.md). Discovery may create and close an empty
  native session, but submits no prompt. Preference writes require explicit intent.
- **status:** `status [PROVIDER]` lists this cwd's executions and their observed
  state. Runtime-owner health alone is not turn completion.
- **result:** `result ID` retrieves the recorded request's report; without an ID,
  `result --provider PROVIDER` chooses the most recent completed execution.
  Preserve pending, expired, unknown and retention-error outcomes.
- **cancel:** prefer `cancel ID`. `cancel --provider PROVIDER` succeeds only with
  one unambiguous unsettled execution. If ambiguous, show candidate IDs and ask.
  Cancellation requested and cancellation confirmed are different. A completed
  execution is not permission to cancel a later follow-up on its session.

Receipts are shared between the two hosts and remain separate from old rescue
records. Keep provider, cwd, execution, acpx session and request identity distinct.
Never edit acpx's private state, clear another task's files or bypass a failed
continuation check. For a deliberately new task, choose fresh explicitly.
