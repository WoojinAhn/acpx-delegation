# Specification review

Review route: Antigravity CLI, requested and reported model
`gemini-4-argon-high`, read-only. The initial verdict was **ready with corrections**.
This was a document review, not an ACP compatibility test.

The same-session review of the revised specification returned **ready for
implementation**, with no remaining specification blockers. Both calls reported
the requested Gemini model. The follow-up included the final provider scope.

| Finding | Disposition |
| --- | --- |
| Strict continuation cannot rely on ordinary CLI reconnect | Use the public shared runtime's same-session-only prompt path; verify saved identities and never ensure a missing continuation |
| Session-wide cancel can affect a later turn | Guard integration admission/cancel with one session mutex; require matching latest request and no settled result; disclose direct-client interference limits |
| Cached-root dependency-install contradiction | Read the shipped lockfile from the cache, install into integration-owned data storage |
| Model selection and changes need capability boundaries | Reject unsupported explicit choices; inherit unchanged model/effort on resume and reject changes |
| Receipt and observation separation | Shared API permits caller-generated request IDs before submission; atomic per-turn intent then transport receipt; passive observation afterward |
| Fixture tests are not provider parity | Maintain a per-provider, per-capability live evidence matrix |
| Claimed collision with the legacy plugin namespace | Not supported by inventory: old plugin names are agy/grok/qoder/cursor, not rescue. Do not require disabling them; still isolate data and installation tests |
| Operations names are ambiguous | List exact shared operation commands and skills |

Owner clarification after the first review excludes Qoder as well as Cursor.
The final supported provider set is Grok, agy and Devin.

Public API basis: [acpx 0.22.0 shared sessions](https://github.com/openclaw/acpx/blob/v0.22.0/docs/shared-sessions.md).
