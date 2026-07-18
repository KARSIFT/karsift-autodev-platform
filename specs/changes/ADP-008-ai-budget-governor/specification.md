# ADP-008 — AI Budget Governor and Cost Reservations

## Problem

Freshness, authority, and duplicate-safe execution leases are necessary but insufficient for unattended AI work. Without a mandatory financial gate, concurrent workers can overcommit project budget, expensive execution classes can be selected without policy, and a stale approval can survive changes to the queued work it was meant to authorize.

ADP-008 makes budget authorization a separate exact-state execution prerequisite. It does not select or invoke an AI provider and it does not activate `AI_DISPATCH`.

## Execution classes

The governor recognizes:

- `DETERMINISTIC`
- `AI_TIER_1`
- `AI_TIER_2`
- `AI_TIER_3`
- `AI_TIER_4`

`DETERMINISTIC` work represents execution that requires no AI provider cost. Its estimated AI cost must be exactly zero.

AI tiers are capability classes rather than provider or model names. Provider/model selection remains a later adapter concern.

## Project budget policy

Each project may have one current budget policy containing:

- monthly budget limit in integer micro-USD;
- per-work maximum reservation in integer micro-USD;
- maximum allowed AI tier, from zero through four;
- enabled/disabled state;
- authenticated updater identity and timestamps.

Money is stored as integer micro-USD to avoid floating-point accounting decisions.

A project policy row is locked during AI budget authorization. This serializes concurrent reservation decisions for the same project and prevents two individually valid approvals from jointly exceeding the monthly limit.

## Exact-state budget decisions

Every budget decision is append-only and bound to:

- project;
- work queue item;
- exact queue state version;
- execution class;
- estimated maximum cost;
- decision outcome and reason;
- calendar-month period start in UTC;
- policy snapshot when a policy exists;
- committed/reserved budget snapshot;
- authenticated actor and timestamp.

Decision outcomes:

- `APPROVED`
- `DENIED`
- `DEFERRED`

Reason codes:

- `NO_AI_REQUIRED`
- `BUDGET_RESERVED`
- `BUDGET_POLICY_MISSING`
- `BUDGET_GOVERNOR_DISABLED`
- `EXECUTION_CLASS_NOT_ALLOWED`
- `PER_WORK_LIMIT_EXCEEDED`
- `PERIOD_BUDGET_EXHAUSTED`

A current `APPROVED` decision is required for every lease, including deterministic work.

## Deterministic path

Deterministic work may be approved without an AI budget policy because it reserves zero AI cost. The explicit decision still binds budget authorization to the exact queue state and proves that the governor classified the work as requiring no AI spend.

## AI reservation path

AI work requires:

1. current `VALID` freshness evidence for the exact queue state;
2. an enabled project budget policy;
3. an allowed AI tier;
4. an estimate within the per-work limit;
5. sufficient remaining monthly budget.

An approved AI decision atomically creates a `RESERVED` cost reservation for the estimated maximum cost.

Current monthly consumption is calculated as:

- `RESERVED`: reserved amount;
- `COMMITTED`: reserved amount;
- `SETTLED`: actual settled amount;
- `RELEASED`: zero.

If current usage plus a proposed reservation would exceed the monthly limit, the decision is `DEFERRED`, not conflated with provider quota or provider unavailability.

## Reservation lifecycle

Reservation states:

- `RESERVED`
- `COMMITTED`
- `SETTLED`
- `RELEASED`

A queue state-version change automatically releases a stale uncommitted `RESERVED` reservation.

When an AI-class execution attempt is created, the matching reservation becomes `COMMITTED` and is bound to that attempt.

A released or expired execution attempt releases its committed reservation.

An AI attempt may not transition to `SUCCEEDED` or `FAILED` while its reservation remains `COMMITTED`. The internal service must settle the reservation with actual cost first. Actual cost may not exceed the reserved maximum.

The settlement primitive exists before provider integration so later adapters have a deterministic financial completion contract.

## Lease gating

The budget-aware lease selector requires the latest exact-state budget decision to be `APPROVED`.

For deterministic work, no reservation is required.

For AI work, the selector additionally requires:

- a matching `RESERVED` reservation for the exact budget decision and queue state;
- effective `AI_DISPATCH` capability for the project.

Therefore budget approval does not activate AI execution.

PostgreSQL independently enforces the same budget requirements before inserting an execution attempt. This defense-in-depth gate prevents direct attempt creation from bypassing the Control Plane selector.

## Capability separation

At A1, global `AI_DISPATCH` remains disabled. ADP-008 may reserve budget for future AI work, but it cannot lease that work while the capability is disabled.

The CI lifecycle uses a temporary project-scoped capability override only inside the disposable test database to prove the future AI reservation/settlement path. The permanent global capability state remains disabled.

## HTTP boundary

Routes:

- `PUT /v1/projects/:projectId/ai-budget-policy`
- `POST /v1/work-queue/:workQueueItemId/budget-decisions`
- `POST /v1/execution-attempts/:executionAttemptId/budget-settlement`

The founder high-authority credential and internal service may update project budget policy.

Only the internal service may authorize exact-state execution budget or settle AI cost.

The founder-interface credential is explicitly denied from all AI budget execution-gate operations.

## Activation boundary

ADP-008 remains activation level A1. It activates no AI provider, no autonomous dispatch, no repository write worker, no automatic merge, no deployment, no production release, and no incident repair.
