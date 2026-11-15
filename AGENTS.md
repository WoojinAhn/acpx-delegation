# Project instructions

Follow the workspace policy in `../AGENTS.md` when available.

- Open an issue before non-trivial implementation. Reference it in commits.
- This project is a thin host integration for acpx, not an ACP implementation.
- Keep queues, process ownership, journals and session persistence in acpx.
- Shared README, specification, manifests and provider registries belong to the coordinator during delegated work.
- Preserve exact model IDs, access intent and session identity. Unknown outcomes are not permission to retry.
- Read-only is a provider restriction, not a universal sandbox guarantee.
- Do not mutate installed host plugins or legacy rescue state as part of tests.
- Keep public documentation free of account details, local paths and private review prompts.
- Distinguish synthetic contract tests from live provider evidence.
