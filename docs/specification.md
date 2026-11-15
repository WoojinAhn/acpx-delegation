# acpx delegation specification

Status: accepted for implementation after Gemini review and same-session re-review;
final scope is Grok, agy and Devin.
Tracking: [#1](https://github.com/WoojinAhn/acpx-delegation/issues/1),
runtime [#2](https://github.com/WoojinAhn/acpx-delegation/issues/2),
packaging [#3](https://github.com/WoojinAhn/acpx-delegation/issues/3).

## Outcome

From an existing Claude Code or Codex conversation, ask a named external coding
agent to investigate or implement a task. A native host worker submits and observes
one execution while the parent can continue. Retrieve its result, follow up in
the same conversation, or explicitly cancel it later.

Use acpx for ACP transport, sessions, queues, process ownership and journals.
Maintain a small host integration and only the executable validation needed to
preserve user choices. Do not rebuild the predecessor's job engine.

## Supported surfaces

One plugin is named `rescue`. Claude entrypoints are `/rescue:grok`,
`/rescue:agy` and `/rescue:devin`; Codex uses corresponding
`$rescue:<provider>` skills. Operations are `/rescue:setup`, `/rescue:models`,
`/rescue:status`, `/rescue:result`, `/rescue:cancel` and the corresponding
`$rescue:<operation>` Codex skills. Setup/models take a provider; status can list
the current cwd; result/cancel take an execution ID or an unambiguous provider.

| Provider | Baseline | New scope |
| --- | --- | --- |
| Grok Build | Claude rescue/setup/status/result/cancel, default model, effort | Both hosts; native worker observation; exact model override |
| Antigravity (agy) | Both hosts, model picker/preferences, parallel models, per-job follow-up | Preserve workflow through installed `agy acp` |
| Devin | No predecessor adapter | Both hosts through `devin acp` |

Cursor and Qoder are excluded by the owner. The baseline is rescue-plugins main
`4fab5d8c9f41c77c2d9f0bdc7e84dd2ad8080ae3`, not an older local checkout.
Legacy command spelling, internal state format and history migration are not
compatibility requirements. Existing installations and records remain untouched.

## Task policy

- Preserve the exact target cwd, prompt, provider and user-supplied model ID.
  Resolve installed plugin code separately from the task cwd.
- Accept prompts through UTF-8 files or stdin; never interpolate task text into
  shell syntax. Launch child processes with argv arrays.
- Fresh tasks are write-capable unless the user asks for read-only. Investigation
  wording alone does not authorize silently changing the access mode.
- Read-only must apply the provider's available restriction and deny unattended
  permission escalation. State its limits; never claim OS-level isolation.
- Unsupported explicit effort, access or isolation requests fail before prompting.
  Worktree management is not implemented: reject the flag, and accept an already
  created worktree as cwd. Separate sessions do not isolate files.
- A single execution defaults to wait delivery. Background delivery releases the
  parent after native-worker dispatch; the worker keeps observing.
- Multiple models use separate fresh sessions and native workers. Reject a
  simultaneous multi-model resume or wait request. Never invent a persistent host
  queue; capacity-blocked work remains visibly unstarted.

## Model selection

Antigravity keeps its existing precedence: explicit ID, resumed requested model,
validated global provider preference, then host-guided selection. Never implicitly
choose Auto or a provider default for agy. Exact IDs are not split on commas.

Grok retains its existing default-model path when no explicit choice
or saved preference exists. Capture the reported model where the provider exposes
it, otherwise report unknown. Devin may use its native default, explicitly labelled.
Explicit choices must be validated by the connected provider without substitution.
If the ACP route cannot validate an explicit selection, reject it before prompting;
do not treat an unreported/default model as verification of the requested ID.

Model discovery and preference browsing do not submit prompts. Only an explicit
save/clear request changes the integration's provider-global preference. Do not
modify vendor CLI settings. Allow exact input when roster discovery is unavailable.
Any picker supports search, bounded pages and cancellation without side effects.

## Sessions and execution receipts

- Explicit fresh/resume choices win. Without one, offer continuation of the most
  recent eligible provider/cwd execution when it exists; otherwise start fresh.
- One fresh task gets a unique named acpx session. Independent tasks never share
  a queue. Follow-up reuses only the selected settled session.
- Resume inherits access, requested model and supported effort. Reject an access
  change in the same session; ask for a fresh execution instead. Initially reject
  in-session model/effort changes; a fresh execution can select a different model.
- Use public `createSharedAcpRuntime`, which uses the existing CLI owner/store and
  enforces `same-session-only` on its prompts. Resume uses `findSession` and checks
  the recorded local/native identities before `startTurn`. Never recreate a missing
  record. Warm and cold continuation use this same strict path.
- Do not pass `sessionOptions.model` back to `ensureSession` for an existing scope:
  acpx 0.22.0 can reconnect and change it outside the strict prompt path. Model is
  selected at fresh creation and inherited on continuation.
- Devin's empty native sessions are not reloadable before their first prompt in
  the tested CLI. Its first request therefore uses acpx's public CLI
  `prompt --no-wait`, allowing acpx's empty-session recovery. This is a fresh-only
  path: create a unique scope with no prior prompt, validate choices, write intent,
  submit once, and persist the queue receipt. Every continuation still uses the
  strict shared-runtime path. No hidden bootstrap prompt is submitted.
- Host worker ID, integration execution ID, acpx session ID, provider session ID
  and acpx request ID are different identities.
- Small durable receipts may store provider, cwd, requested choices, acpx identity,
  request ID, launch intent and timestamps. They are links to upstream execution,
  not another queue, transcript store, process supervisor or source of completion.
- For shared-runtime submissions, generate the acpx request ID before submission.
  Write a unique per-turn launch-intent receipt atomically, then attach the exact
  session handle and persist it before `startTurn`. Record transport acceptance
  when `promptStarted` resolves; it is not queue acceptance or task completion.
  Follow-up creates a new receipt linked to the same session, never overwrites an
  old turn. Do not persist an independently inferred running/completed state.
  Missing/malformed receipts produce an
  unknown outcome; never automatically resubmit. Preserve enough identity for
  status inspection. Concurrent continuation of the same session is refused.
- For Devin's CLI first submission, `requestId` is null until the CLI queue
  acknowledgement supplies it. Label this `queued`, not transport-accepted.
  Empty-session native identity is provisional until the first settled result;
  bind the final identity through public session metadata before continuation.
  A lost acknowledgement remains unknown even if a task may be running.
- Claude and Codex use the same integration receipt/preference store.
  Use `RESCUE_DATA_DIR` for isolated tests; the default store is separate from
  legacy rescue state and from host plugin caches.

## Observation, result and cancellation

Use persistent prompts and acpx's passive watch journal. `status` describes
queue-owner health; a request-correlated settled `turn_result` is completion.
Do not use `exec` for resumable tasks or a raw stop reason as proof of finalization.

Native workers observe in slices of at most 60 seconds, with a 15-minute overall
observation deadline. Expiry/detachment is incomplete observation and leaves work
running. Stopping a host worker is not task cancellation. Receipt/result lookup
must remain available in later turns and across hosts.
Submission detaches using shared `closeStream`/`shutdown` after transport
acceptance, then passive watch owns observation. A setup/submission budget is
separate from the observation deadline and never authorizes a retry.

Result retrieval replays the public watch interface for the recorded request,
returning text, terminal state and requested/reported choices. Retention expiry,
owner loss and missing journal data are explicit incomplete/unknown outcomes.
No private `.acpx` storage parsing. A background completion notification does not
promise a new parent answer without an active parent turn.

Cancel targets one recorded execution and uses explicit acpx cancellation.
Follow-up admission and cancellation share a short-lived per-session filesystem
mutex. Under it, inspect the latest receipt, upstream last request identity and
matching settled journal result. An already settled request is a no-op; a
superseded or uncertain target is refused. Provider-only cancel requires exactly
one unambiguous unsettled execution; otherwise list candidate IDs.
The public shared API cannot cancel a request by ID from a new process: after
these checks it cancels the session's current request. This protects operations
through this integration, not competing direct acpx calls by the same OS user.
For a queued Devin first request, local record/scope and current request identity
are authoritative for cancellation while native identity is provisional. No
follow-up can enter until that first request settles and identity is bound.
Confirm settlement where available; never call cancellation requested equivalent
to cancellation confirmed. A completed task must not cancel a later follow-up.
Cooperative ACP cancellation does not guarantee every remote side effect stopped.

## Dependencies and packaging

- Start from released acpx 0.22.0, pinned exactly with a lockfile; record the tested
  provider CLI versions separately. An acpx pin does not pin external CLIs.
- Do not rely on unreleased Ctrl+C cancellation, shared-session model or
  settled-turn cancellation fixes. Use explicit cancel and request correlation.
- Use the public shared-runtime client for submission/observation, except the
  fresh-only Devin CLI queue path described above. The shared runtime supplies
  strict continuation and caller-generated request IDs absent from the CLI.
  Do not import private acpx modules or add a second supervisor.
- Install the locked runtime into an integration-owned data directory through an
  explicit setup step, not globally or into a versioned host plugin cache. Ship the
  runtime package manifest and lockfile inside the plugin subtree. Setup checks
  prerequisites and reports authentication actions without initiating login.
- Deliver both Claude and native Codex manifests/marketplaces, with shared policy
  and host-specific entrypoints. Resolve paths from the actual installed package.
- Document installation, manual upgrades, compatibility evidence and provider
  limitations. Do not silently install/update vendor CLIs or replace old plugins.

## Acceptance

1. Both host packages discover the provider and operations entrypoints, including
   `rescue:grok`, without duplicate migrated Codex commands.
2. A native worker submits once, parent background delivery can continue, and
   result recovery uses the same receipt after the worker stops observing.
3. Each provider passes setup and a bounded live prompt where account access
   permits it. Record blocked authentication/quota/capability as unverified,
   never as passed or as silently dropped scope.
   Track setup, fresh prompt, exact model, read-only, strict resume and cancel
   independently per provider: verified-live, unverified-live with reason, or
   unsupported with a pre-prompt rejection. Fixture success alone proves no
   provider capability.
4. Exact model selection, global preference opt-in and agy multi-model policy are
   tested. Requested and reported models remain separate.
5. Successful follow-up keeps native session identity; unavailable resume and
   access changes fail closed. No automatic fresh fallback after unknown outcome.
6. Observation timeout leaves execution running; explicit cancellation targets
   the intended request and reports confirmation separately from request receipt.
7. Integration tests cover journal/request correlation, incomplete observations,
   malformed/uncertain submission and concurrent follow-up admission using a
   controlled ACP fixture through the pinned real acpx shared runtime.
8. README commands are checked against installed help and packaged file paths.
   Public claims distinguish fixture tests, live CLI checks and host UI loading.

## Explicit non-goals

No autonomous scheduler, workflow DAG, web UI, generic plugin framework, private
acpx state migration, legacy transcript conversion, vendor print-output parsers,
automatic fallback to a different provider/model, Qoder support, or automatic
removal of rescue.

## Open implementation checks

- Verify each installed provider's ACP startup, model/effort and read-only controls.
- Verify CLI receipts and public session metadata expose the identities required
  for strict continuation and per-request cancellation.
- Verify setup reads the manifest/lockfile from each installed plugin subtree and
  installs into the integration data directory without mutating host caches.
  Host discovery uses isolated host state or manifest validation, never overwrites
  the user's current plugins.
  Unsupported invariants must remain visible blockers, not undocumented defaults.
