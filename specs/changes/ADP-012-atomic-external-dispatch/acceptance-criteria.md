# ADP-012 Acceptance Criteria

ADP-012 is complete only when one exact candidate revision proves all of the following.

- Every builder dispatch claim is bound to one builder invocation, immutable plan ID/hash, owner, token, and stable plan-derived idempotency key.
- At most one unexpired `ACTIVE` dispatch claim can exist for one builder invocation.
- Concurrent run requests execute the adapter at most once.
- A caller that does not newly acquire the dispatch claim returns without adapter execution.
- Dispatch claim heartbeat requires the correct active claim token.
- Expired claims are marked `EXPIRED` before recovery and a recovered claim reuses the same stable idempotency key.
- Every newly acquired claim revalidates the selected provider against the latest capacity observation for `CODE_BUILDER`.
- A newer provider observation supersedes the observation linked to the earlier provider-dispatch decision.
- Fresh `QUOTA_EXHAUSTED` remains distinct from provider unavailability.
- Missing, stale, degraded, or unavailable latest capacity fails closed before adapter execution.
- Provider revalidation evidence is append-only and bound to the dispatch claim and immutable plan provider evidence.
- PostgreSQL rejects `PREPARED → RUNNING` when no active, unexpired, `READY` dispatch claim exists.
- The stable dispatch idempotency key is passed into the provider-neutral adapter input.
- The existing dry-run adapter still records zero external provider calls and zero repository mutations.
- Existing builder invocation/result evidence remains immutable and idempotent.
- Founder and founder-interface credentials cannot access dispatch claim tokens or operate the builder runtime.
- All nine migrations apply and rerun idempotently through the migration runner.
- All prior queue, freshness, authorization, budget, Task Context Pack, provider-readiness, and controlled-builder lifecycles continue to pass.
- The dedicated real PostgreSQL dispatch concurrency, latest-provider-revalidation, heartbeat, and expiry-recovery lifecycle passes.
- Permanent global `AI_DISPATCH` and `AUTOMATED_WRITE` remain disabled.
- No real external AI call, repository mutation, commit, pull request, verification, merge, deployment, or production release occurs.
