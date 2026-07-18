# ADP-009 — Immutable Task Context Packs and Execution Evidence Binding

## Problem

Before an implementation worker can be connected, the Control Plane must guarantee that the worker receives one exact, reproducible execution context rather than an ad hoc prompt assembled from whatever happens to be current at dispatch time.

The execution lease already depends on authorization, freshness, budget, capability, and duplicate-safe claiming. ADP-009 preserves that proof by snapshotting the exact decision-row identifiers used at claim time and binding the worker handoff to those immutable references.

## Execution-attempt evidence snapshot

Every new execution attempt must record:

- the queue state version immediately before the lease claim;
- the exact `VALID` freshness validation row;
- the exact effective `AUTHORIZED` Change Contract authorization decision;
- the exact `APPROVED` budget decision.

PostgreSQL independently verifies these references before the execution attempt can be inserted. A new attempt without complete evidence references is rejected.

The lease selector obtains the evidence rows in the same transaction and while holding the selected work item lock, then inserts the execution attempt before advancing the queue state to `RUNNING`.

## Task Context Pack cardinality and immutability

Each execution attempt may have at most one Task Context Pack.

The pack is append-only. Update and delete operations are rejected by PostgreSQL.

The pack row redundantly stores the canonical evidence references and Change Contract version/hash so audit queries do not need to infer execution provenance from later mutable state.

## Pack creation authority

Creating a new pack requires:

- an existing execution attempt;
- a valid matching lease token;
- an `ACTIVE`, unexpired lease;
- complete execution-attempt evidence snapshots;
- a repository base branch;
- a lowercase hexadecimal base commit SHA;
- an explicit list of relevant repository-relative paths.

Only the internal Control Plane service may create or read Task Context Packs through the HTTP interface.

The lease token is used only as proof. It is never included in Task Context Pack content.

## Idempotency

If a pack already exists for an execution attempt, a retry with the same lease proof, base branch, base commit SHA, and normalized relevant paths returns the existing immutable pack.

A retry that changes the repository snapshot or relevant path set is rejected as a conflict.

This idempotent read-back remains available after the attempt becomes terminal, provided the caller still proves the original lease token. A new pack cannot be created for an inactive or expired attempt.

## Repository snapshot

The Control Plane receives an explicit repository snapshot consisting of:

- `baseBranch`;
- `baseCommitSha`;
- normalized, sorted, deduplicated `relevantPaths`.

ADP-009 does not resolve the SHA from GitHub. Repository resolution belongs to the later GitHub/worker adapter. This keeps the pack builder deterministic and independently testable.

Relevant paths must:

- be repository-relative;
- use normalized `/` separators;
- contain no empty, `.` or `..` segments;
- be deduplicated and sorted before hashing.

## Canonical pack content

The pack schema version is `task-context-pack-v1`.

Pack content includes:

### Project

- project ID, slug, and name;
- repository full name;
- default branch;
- integration branch.

### Derived execution objective

The pack surfaces immutable Change Contract sections when present:

- objective;
- deliverables;
- acceptance criteria;
- interfaces;
- tests;
- risks;
- prohibited scope;
- expected evidence;
- governance.

Missing optional sections use deterministic `null` or empty-array fallbacks.

### Exact Change Contract

- contract ID and stable ID;
- version ID and version number;
- immutable content hash;
- full immutable contract content.

### Work

- work queue item ID;
- task ID, title, and description;
- priority;
- execution policy;
- stable idempotency key;
- pre-claim queue state version.

### Repository snapshot

- base branch;
- base commit SHA;
- normalized relevant paths.

### Evidence

The pack embeds the exact evidence referenced by the execution attempt:

- freshness validation ID, outcome, reason, checks, and timestamp;
- authorization decision ID, policy, risk, authority, facts, actor, and timestamp;
- budget decision ID, execution class, estimate, outcome, reason, policy snapshot, reservation summary, and timestamp.

### Execution

- attempt ID and attempt number;
- lease owner;
- lease expiry;
- attempt creation timestamp.

The lease token is excluded.

## Content hash

Pack content is serialized through the Control Plane canonical stable-JSON algorithm and hashed with SHA-256.

The stored `content_hash` must therefore be reproducible from the stored `content` alone.

## Observability

Project status includes:

- total Task Context Pack count;
- recent pack metadata.

Platform status includes the total pack count.

## Activation boundary

ADP-009 remains activation level A1. It creates execution provenance and a future worker handoff artifact only. It does not invoke Codex or any other model, enable `AI_DISPATCH`, grant repository write credentials, merge code, deploy infrastructure, release production changes, or repair incidents autonomously.
