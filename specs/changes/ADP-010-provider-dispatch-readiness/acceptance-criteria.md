# ADP-010 Acceptance Criteria

ADP-010 is complete only when all of the following are proven on one exact candidate revision.

- Provider routes are project-scoped, execution-class/capability-specific, ordered, bounded, and duplicate-free.
- Capacity observations are append-only and expire.
- `QUOTA_EXHAUSTED` maps to `QUOTA`, while missing, stale, degraded, or unavailable capacity maps to `PROVIDER_UNAVAILABLE` with distinct reason codes.
- Routing falls through to the first provider with fresh healthy capacity.
- Missing routing policy produces an explicit wait decision.
- Dispatch decisions are append-only and bound to exact work item, queue state, and budget decision evidence.
- A newer exact-state WAIT decision prevents an older READY decision from granting a lease.
- Deterministic work can execute without provider evidence and cannot bind provider dispatch evidence.
- AI-class work cannot receive a lease without the latest exact-state READY provider decision and a healthy unexpired linked observation.
- Budget approval and provider readiness do not enable `AI_DISPATCH`.
- Execution attempts snapshot the exact provider dispatch decision used at claim time.
- Task Context Pack schema v2 contains immutable provider routing and capacity evidence for AI work and `null` provider evidence for deterministic work.
- Founder-interface credentials cannot mutate provider routing or readiness evidence.
- Only the internal Control Plane service can record capacity and evaluate dispatch readiness.
- All seven migrations apply and rerun idempotently through the migration runner.
- Existing queue, freshness, authorization, budget, and Task Context Pack lifecycle tests continue to pass.
- The dedicated real PostgreSQL provider-readiness lifecycle passes.
- All permanent global autonomous capability switches remain disabled.
