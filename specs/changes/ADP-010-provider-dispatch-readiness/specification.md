# ADP-010 — Provider Capacity and Dispatch Readiness

## Objective

Add a mandatory provider-readiness gate for AI-class work before any external AI worker is connected. Budget approval must not imply that a provider is available, within quota, or safe to dispatch.

## Required behavior

Each project may configure an ordered provider route for an AI execution class and capability. Provider identifiers are machine keys and workflow logic remains capability-oriented rather than model-name-oriented.

Capacity observations are append-only and expire. Supported states are `HEALTHY`, `DEGRADED`, `QUOTA_EXHAUSTED`, and `UNAVAILABLE`.

For an eligible AI-class work item with an exact approved budget decision, the Control Plane evaluates the configured route in order and records an append-only exact-state dispatch decision:

- select the first provider with a fresh `HEALTHY` observation;
- otherwise wait using the primary configured provider's precise reason;
- distinguish `QUOTA` from `PROVIDER_UNAVAILABLE`;
- record missing routing policy and stale/missing capacity explicitly.

A new AI execution attempt must require all existing gates plus the latest exact-state `READY` provider decision and a still-healthy, unexpired linked observation. Deterministic work remains provider-independent and must carry no provider dispatch evidence.

Every execution attempt snapshots the provider dispatch decision used at claim time. Task Context Pack schema v2 includes the exact route version, ordered candidates, selected provider, readiness decision, and linked capacity observation. Later routing edits or observations cannot rewrite an existing immutable pack.

## Authority boundary

The founder or internal service may configure provider routing policy. Only the internal Control Plane service may record provider capacity observations or create dispatch-readiness decisions. The founder-interface credential has no provider-gate write authority.

## Activation boundary

This change does not call any external AI provider, configure provider credentials, enable `AI_DISPATCH`, grant repository-write authority, invoke a verifier, merge code automatically, deploy, or release production changes.

## Canonical truth

- PostgreSQL stores routing policy, append-only capacity observations, append-only dispatch decisions, and exact attempt evidence references.
- Provider observations are operational evidence, not permanent provider configuration truth.
- GitHub remains canonical code and specification truth.
- Task Context Packs are immutable execution handoff artifacts.
