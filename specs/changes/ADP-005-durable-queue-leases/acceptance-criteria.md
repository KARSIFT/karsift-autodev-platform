# ADP-005 Acceptance Criteria

## AC-01 — Queue semantics are durable

Given a task,
when it is queued,
then project, task, priority, execution policy, status, waiting reason, schedule, state version, and idempotency key are stored durably.

## AC-02 — Idempotency keys are stable and unique

Given one project,
when a second work item attempts to reuse an existing idempotency key,
then the database rejects it.

When the same work item is retried,
then every execution attempt carries the original idempotency key.

## AC-03 — Eligibility is coherent

Given queued or blocked work,
when it becomes eligible,
then waiting reason is `NONE`.

When work is blocked,
then a non-`NONE` waiting reason is required.

## AC-04 — Only one active lease exists

Given one eligible work item and concurrent execution authority,
when an active attempt already exists,
then a second active attempt for the same item is rejected by the database.

## AC-05 — Claiming is duplicate-safe

Given eligible work,
when a worker claims it,
then the claim is selected with row locking/skip-locked semantics, the queue item becomes `RUNNING`, and another claim cannot receive the same item while the lease is active.

## AC-06 — Lease tokens are authoritative

Given an active lease,
when a heartbeat, release, or completion uses the wrong or stale token,
then the operation is rejected.

## AC-07 — Released work can retry safely

Given an active lease,
when it is released without a waiting condition,
then the attempt becomes `RELEASED`, the work returns to `ELIGIBLE`, and the next attempt increments its attempt number while retaining the same idempotency key.

## AC-08 — Expired leases recover

Given an expired active attempt on running work,
when the next claim cycle executes,
then the expired attempt becomes `EXPIRED`, the item returns to eligibility, and a new claim can be issued.

## AC-09 — Terminal work is not reclaimed

Given a successfully completed lease,
when the queue is claimed again,
then the completed item is not returned.

## AC-10 — Queue state is observable

Given platform or project status,
when status is requested,
then queue counts and active execution lease counts are included.

## AC-11 — Exact PostgreSQL verification passes

Given the exact candidate revision,
when CI runs after migrations,
then the real database verification proves single-active-lease enforcement, stale-token rejection, heartbeat, release/retry, stable idempotency, expiry recovery, and completion.

## AC-12 — No autonomous dispatch is activated

Given ADP-005 is integrated,
when capability state is inspected,
then `AI_DISPATCH` and all other autonomous capabilities remain disabled.
