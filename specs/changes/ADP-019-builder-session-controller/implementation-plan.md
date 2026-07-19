# ADP-019 Implementation Plan

## Phase 1 — Durable session and step claims

- Add immutable session-plan evidence and one mutable session row per builder invocation.
- Add append-only terminal session evidence.
- Add duplicate-safe step claims with bounded lease, owner token, expiry, release, and completion.
- Enforce session state transitions and one active claim in PostgreSQL.

## Phase 2 — Step controller

Implement a controller that performs exactly one operation per step claim:

- `PREPARED` → validate bound execution/workspace evidence and enter `READY_FOR_TURN`.
- `READY_FOR_TURN` → prepare or generate one ADP-017 proposal, depending on current proposal state and dispatch authority.
- generated proposal → materialize one ADP-018 action and enter `WAITING_ACTION`.
- `WAITING_ACTION` → invoke at most one child operation already materialized by ADP-018, or reconcile the action after child completion.
- satisfied non-terminal action → return to `READY_FOR_TURN` when turn budget remains.
- satisfied COMPLETE/BLOCKED action → record immutable session terminal evidence.

No step function contains an internal retry/while loop that advances more than one workflow operation.

## Phase 3 — Authority and lease checks

- Revalidate the bound execution attempt before every non-terminal step.
- Reuse existing execution-lease heartbeat semantics where possible; otherwise add a narrowly scoped heartbeat operation.
- Fail closed when execution authority is stale, released, cancelled, or expired.
- Keep execution lease tokens out of session response and audit payloads.

## Phase 4 — HTTP and observability

Add internal-only operations to:

- prepare a session for one builder invocation;
- claim/advance one bounded session step;
- read one session;
- cancel a session;
- inspect project/platform session status.

Founder-facing credentials remain excluded.

## Phase 5 — Validation

Add deterministic tests for:

- state transitions;
- step claim duplicate safety and expiry recovery;
- one-operation-per-step behavior;
- exact child entity routing;
- no raw proposal execution;
- turn-budget exhaustion;
- terminal evidence hashing;
- stale execution-authority rejection;
- credential boundaries.

Add a disposable PostgreSQL/local-workspace lifecycle using fixture proposal behavior. The lifecycle must demonstrate a bounded multi-step session and confirm all permanent global autonomous capabilities remain disabled.

## Explicit non-goals

- live provider credentials or calls;
- recursive self-driving loops;
- new shell/file mutation primitives;
- remote repository publication;
- independent AI verification;
- automatic merge or deployment.
