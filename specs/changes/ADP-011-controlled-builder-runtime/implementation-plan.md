# ADP-011 Implementation Plan

1. Define the immutable provider-neutral builder invocation plan and bounded result contract.
2. Add immutable plan/result tables plus a durable invocation state machine.
3. Enforce exact execution lease, Task Context Pack, and provider-dispatch evidence in PostgreSQL.
4. Add a provider-neutral builder adapter registry.
5. Implement only a deterministic `dry-run` adapter with side-effect mode `NONE`.
6. Add prepare/start/complete/read store operations with idempotent preparation and terminal evidence handling.
7. Recheck lease, provider readiness, and `AI_DISPATCH` at invocation start.
8. Expose internal-only builder runtime HTTP operations and project/platform observability.
9. Verify the complete lifecycle against PostgreSQL, including immutable evidence and zero side effects.
10. Run the full exact-environment CI chain and integrate only one fully validated head revision.
11. Defer real provider calls, dispatch deduplication, refreshed provider observations, credentials, and repository-write sandboxes to later governed changes.
