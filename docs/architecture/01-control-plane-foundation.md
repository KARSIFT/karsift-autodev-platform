# Control Plane Foundation

## Activation level

ADP-002 implements activation level **A1 — Coordinate**.

The Control Plane can durably record and report governed work. It cannot dispatch AI workers, merge code automatically, deploy software, release production changes, or repair incidents autonomously.

## Runtime boundary

The initial service is a single TypeScript/Node.js process backed by PostgreSQL.

```text
Founder / internal caller
        |
        | Bearer-authenticated internal API
        v
KARSIFT Control Plane
        |
        +-- project registry
        +-- founder requests
        +-- decisions
        +-- immutable change-contract versions
        +-- tasks
        +-- workflow runs
        +-- persistent capability kill switches
        +-- append-only audit events
        |
        v
PostgreSQL
```

## Sources of truth

- GitHub repositories remain the source of truth for code, product documents, and version-controlled specifications.
- The exact immutable Change Contract version is the source of truth for an authorized change.
- PostgreSQL is the source of truth for workflow state.
- Audit events are append-only evidence of important state changes.
- Production systems, when introduced later, will remain the source of truth for live production state.

## Multi-project isolation baseline

Every project has an explicit project identity and repository mapping.

The shared Control Plane does not imply shared project credentials. Future repository credentials, provider budgets, policies, environment access, and release capabilities must be granted per project.

## Capability state

The following autonomous capabilities are persisted as kill switches and default to disabled:

- `AUTOMATED_WRITE`
- `AI_DISPATCH`
- `AUTO_MERGE`
- `DEPLOYMENT`
- `PRODUCTION_RELEASE`
- `INCIDENT_REPAIR`

ADP-002 exposes only a disable path. It intentionally has no API path that can enable an autonomous capability.

## Concurrency safety

Workflow state transitions use:

- a row lock;
- an explicit state machine;
- an expected `state_version`;
- atomic state-version increment;
- an audit event in the same database transaction.

This establishes the first optimistic-concurrency baseline before durable execution leases are introduced in a later change.

## Provider-neutral boundary

`WorkerAdapter` defines the future integration boundary for implementation workers without activating a concrete worker or dispatch path.

No provider credential is part of ADP-002.

## Founder authority boundary

ADP-002 uses separate bearer credentials for the founder-facing authority path and the internal service path.

The internal service credential is always attributed as `SYSTEM`. It cannot self-assert `FOUNDER` identity through request headers, and it cannot record an R4 decision. This prevents the initial internal integration credential from fabricating founder authority.
