# ADP-005 Specification — Durable Work Queue and Execution Leases

## Problem

The Control Plane can record tasks but has no durable scheduling object or concurrency-safe execution authority. Connecting an unattended builder without these primitives would allow duplicate execution, stale workers, ambiguous quota waiting, and retries that accidentally create repeated external side effects.

## Desired outcome

Introduce a durable project-scoped work queue and PostgreSQL-backed execution leases. The Control Plane can classify waiting work, mark it eligible, atomically grant one active lease to one worker, extend that lease with heartbeats, recover expired leases, release recoverable work, and record terminal outcomes while preserving one stable idempotency key across retries.

## Functional requirements

### FR-01 — Durable work queue semantics

Each queue item records a project, task, priority, execution policy, status, waiting reason, optional schedule, stable idempotency key, and optimistic state version.

Statuses and waiting reasons must remain separate concepts.

### FR-02 — Stable idempotency

A project-scoped idempotency key must be unique for each durable work item and must be reused by every retry attempt for that item.

### FR-03 — Explicit eligibility

Only `QUEUED`, `BLOCKED`, or already `ELIGIBLE` work may be reclassified by the eligibility operation. Eligible work must use waiting reason `NONE`; blocked work must use a concrete non-`NONE` reason.

### FR-04 — Atomic claiming

Claiming uses a PostgreSQL transaction with `FOR UPDATE SKIP LOCKED` so concurrent claimers cannot receive the same eligible item. A partial unique database index independently prevents more than one active execution attempt for a work item.

### FR-05 — Lease authority

A claim produces an opaque lease token, lease owner, expiry time, attempt number, and the durable idempotency key. Heartbeat, release, and completion require the current active token and reject stale, incorrect, expired, or completed leases.

### FR-06 — Retry and recovery

A released item may become eligible again without changing its idempotency key. Expired active attempts are marked `EXPIRED` and their still-running queue items return to `ELIGIBLE` before the next atomic claim.

### FR-07 — Terminal outcomes

Successful completion marks the attempt `SUCCEEDED` and queue item `COMPLETED`. Failed completion marks the attempt and queue item `FAILED`. Completed or failed items are not claimable.

### FR-08 — Audit and observability

Queue creation, eligibility changes, claims, expiry recovery, release, and terminal attempt outcomes are auditable. Project/platform status reports queue counts and active lease counts.

### FR-09 — Internal API boundary

Queue and lease operations are authenticated `/v1/*` operations but are not exposed through the least-privilege founder GPT Action schema.

## Security and activation requirements

- No AI provider is called by ADP-005.
- `AI_DISPATCH` and every other autonomous capability remain disabled.
- Lease authority is coordination authority only; no implementation worker adapter is connected to it yet.
- The database remains the final duplicate-prevention authority.

## Definition of completion

ADP-005 is complete when deterministic tests and a real PostgreSQL verification exercise queue creation, eligibility, single-active-lease enforcement, stale-token rejection, heartbeat, release/retry, stable idempotency, expired-lease recovery, and terminal completion on the exact candidate revision.
