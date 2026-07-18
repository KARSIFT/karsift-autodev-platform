# Implementation Plan

## 1. Domain contract

Define canonical action-decision, materialization, turn, and result-evidence content with stable JSON hashes. Validate action-specific payloads without performing side effects.

## 2. PostgreSQL migration

Add proposal-action decisions, runs, destination links, and immutable evidence. Enforce:

- exact ADP-017 proposal evidence binding;
- one decision per proposal run;
- one active action per builder invocation;
- finite immutable turn limit;
- guarded state transitions;
- destination-record type matching;
- append-only decision and evidence tables.

## 3. Store and service

Implement idempotent prepare, authorize, materialize, complete, read, and status operations. The service may call destination stores only through typed ADP-014/015/016 preparation interfaces. It must never invoke command runners, context capturers, or mutation appliers directly.

## 4. HTTP boundary

Expose internal-only proposal-action operations. Reuse the established authentication boundary and deterministic error mapping. Do not expose raw source snapshots or secret-bearing data.

## 5. Runtime wiring

Attach the orchestration runtime and route in `main.ts`. Add package and canonical CI lifecycle commands. Extend the PostgreSQL foundation inventory for the new migration and tables.

## 6. Verification

Prove all five action types, destination validation reuse, duplicate safety, concurrency serialization, turn exhaustion, stale workspace/capability rejection, fresh-result requirements, immutability, and zero new external or publication side effects.

## Activation boundary

ADP-018 remains at A1. It coordinates existing bounded subsystems but does not connect a live model, recursively execute proposals, publish repository changes, merge, deploy, release production, or repair incidents.
