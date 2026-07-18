# ADP-005 Implementation Plan

1. Add queue and execution-attempt schema with project-scoped foreign keys and idempotency constraints.
2. Add deterministic queue-domain semantics for execution policy, waiting reason, and eligibility.
3. Add Control Plane store operations for queueing and eligibility.
4. Add atomic PostgreSQL claim logic using `FOR UPDATE SKIP LOCKED` plus a one-active-attempt partial unique index.
5. Add heartbeat, release, completion, and expired-lease recovery operations.
6. Add authenticated internal HTTP operations while preserving the founder-interface deny-by-default boundary.
7. Extend status reporting with queue and active-lease observability.
8. Add deterministic source/API tests and migration-contract checks.
9. Add a real PostgreSQL work-queue verification script and execute it in CI after migrations.
10. Integrate only after the exact candidate passes all existing deployment/database gates plus the new lease lifecycle verification.

No AI provider adapter is connected and no autonomous capability is enabled by this change.
