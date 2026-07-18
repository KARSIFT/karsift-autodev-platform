# ADP-011 Acceptance Criteria

ADP-011 is complete only when one exact candidate revision proves all of the following.

- Builder invocation plans are immutable and bound to one exact execution attempt, Task Context Pack hash, provider dispatch decision, provider key, adapter key, side-effect mode, and bounded execution limits.
- One execution attempt can have at most one builder plan and one builder invocation.
- Identical plan preparation retries are idempotent; changed limits or plan evidence conflict.
- Plan preparation requires a valid lease token and an active unexpired execution attempt.
- PostgreSQL rejects mismatched Task Context Pack or provider evidence.
- The only supported adapter is `dry-run` with side-effect mode `NONE`.
- The dry-run adapter records `externalProviderCalled = false` and `repositoryMutated = false`.
- Starting an invocation rechecks the active execution lease, current validity of the linked provider observation, and effective `AI_DISPATCH` capability.
- Founder and founder-interface credentials cannot operate the builder runtime.
- Builder results are append-only, deterministically hashed, and bounded by immutable plan limits.
- Identical terminal result retries are idempotent; changed terminal evidence conflicts.
- PostgreSQL enforces valid invocation status transitions and result limits.
- Project and platform status expose builder invocation state without exposing credentials.
- All eight migrations apply and rerun idempotently through the migration runner.
- All previous queue, freshness, authorization, budget, Task Context Pack, and provider-readiness lifecycles continue to pass.
- The dedicated real PostgreSQL controlled-builder lifecycle passes.
- Permanent global `AI_DISPATCH` and `AUTOMATED_WRITE` remain disabled.
- No external provider call, repository mutation, commit, pull request, verification, merge, deployment, or production release occurs.
