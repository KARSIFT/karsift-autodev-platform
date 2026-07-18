# ADP-006 Specification — Freshness and Continuing Authority Validation

## Problem

A durable queue and duplicate-safe lease prevent concurrent duplicate execution, but they do not prove that the queued work is still correct to execute. Between queueing and execution, a project can be paused, a task can become terminal, a Change Contract can be cancelled or superseded, or a newer contract version can replace the assumptions under which the task was created.

## Desired outcome

Require deterministic, append-only validation evidence immediately before a work item can receive an execution lease. The evidence is bound to the exact queue state version and exact Change Contract version/hash, while the claim transaction also re-checks current project, task, and Change Contract facts to prevent time-of-check/time-of-use authority drift.

## Functional requirements

### FR-01 — Append-only validation evidence

Each validation records the work item, project, queue state version, task, exact Change Contract/version/hash, outcome, reason code, deterministic checks, actor, and timestamp. Validation records cannot be updated or deleted.

### FR-02 — Deterministic outcomes

The validator produces one of:

- `VALID` — current and authorized;
- `BLOCKED` — temporarily non-executable;
- `STALE` — a newer Change Contract version exists;
- `SUPERSEDED` — the task or contract is terminal/cancelled/superseded.

### FR-03 — Project validation

Only an `ACTIVE` project can validate as `VALID`. Paused or archived projects become blocked by policy.

### FR-04 — Task validation

Completed, failed, or cancelled tasks are superseded. A task already in `RUNNING` state is blocked from receiving a new queue execution authority.

### FR-05 — Continuing Change Contract authority

The exact Change Contract must currently have status `AUTHORIZED`. Draft contracts are blocked awaiting authority. Cancelled or superseded contracts supersede queued work.

ADP-006 consumes this authority state but does not grant it or define the future policy engine that may grant it.

### FR-06 — Exact version freshness

The task's immutable Change Contract version must equal the contract's current version. Otherwise the queued work is stale and blocked from execution.

### FR-07 — Queue-state binding

A successful validation is valid only for the exact current `work_queue_items.state_version`. Any release, manual reclassification, or expired-lease recovery changes the state version and invalidates prior validation evidence.

### FR-08 — Claim-time recheck

Atomic lease claiming must require matching current `VALID` evidence and must also re-check current project status, task status, Change Contract authorization, current version, exact version ID, and exact content hash inside the claim query. Changes after validation therefore prevent execution without relying on a separate invalidation job.

### FR-09 — Deterministic state response

A valid validation makes queue work eligible. Unauthorized or inactive work becomes blocked with an explicit waiting reason. Stale work becomes blocked by policy. Terminal task/contract work becomes superseded.

### FR-10 — Observability and API

The authenticated internal API exposes a validation operation and project/platform status includes validation outcome counts and recent validation evidence. The least-privilege founder GPT Action does not gain this operation.

## Security and activation requirements

- No AI provider is called.
- No semantic decision is delegated to AI.
- No Change Contract authority is granted by this change.
- `AI_DISPATCH` remains disabled.
- Lease claiming remains impossible without deterministic current validation evidence.

## Definition of completion

ADP-006 is complete when deterministic tests and a real PostgreSQL verification prove unauthorized blocking, authorization recovery, queue-state invalidation, retry revalidation, stale version detection, post-validation authority revocation blocking, supersession, and append-only validation evidence on the exact candidate revision.
