# ADP-013 Acceptance Criteria

ADP-013 is complete only when one exact candidate revision proves all of the following.

- Repository workspace plans are immutable and bound to one prepared builder invocation, exact execution attempt, Task Context Pack ID/hash, repository identity, base branch/SHA, relevant-path scope, mode, and adapter.
- One builder invocation can have at most one repository workspace plan.
- Workspace keys and local branch names are deterministically derived from the immutable plan hash.
- WRITE workspace preparation fails unless effective project `AUTOMATED_WRITE` is enabled.
- WRITE finalization rechecks `AUTOMATED_WRITE` and fails closed if authority was removed after materialization.
- READ_ONLY workspace preparation does not require `AUTOMATED_WRITE`.
- The local Git adapter accepts only source paths beneath the configured source root and workspace paths beneath the configured workspace root.
- Materialization checks out the exact Task Context Pack base commit in an isolated clone and verifies `HEAD` matches it.
- Materialized workspace changes do not mutate the source repository.
- The local adapter performs no remote fetch, push, credential setup, or GitHub operation.
- Final evidence contains normalized changed paths and deterministic per-path content hashes.
- WRITE changes outside the immutable relevant-path scope produce `SCOPE_VIOLATION` evidence.
- READ_ONLY workspaces with any change produce scope-violation evidence.
- Empty WRITE scope permits no changed path.
- Workspace plans and final evidence are append-only.
- Successful and scope-violating finalization record durable evidence before disposable workspace cleanup.
- Invalid source traversal is rejected and the failed materialization is not left usable.
- Internal-only workspace operations are inaccessible to founder and founder-interface credentials.
- The runtime image contains Git and dedicated source/workspace directories.
- All ten migrations apply and rerun idempotently through the migration runner.
- All prior queue, freshness, authorization, budget, Task Context Pack, provider, builder-runtime, and atomic-dispatch lifecycles continue to pass.
- The dedicated real PostgreSQL + local Git workspace lifecycle passes.
- Permanent global `AI_DISPATCH` and `AUTOMATED_WRITE` remain disabled.
- No remote clone, external AI call, commit, push, pull request, verification, merge, deployment, or production release occurs.
