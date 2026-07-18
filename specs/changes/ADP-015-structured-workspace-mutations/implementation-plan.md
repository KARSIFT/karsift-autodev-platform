# Implementation Plan

1. Add deterministic structured mutation validation, scope enforcement, limits, and plan hashing.
2. Add a root-confined atomic UTF-8 file applier with exact before-hash preflight and rollback.
3. Add PostgreSQL mutation plan, run, and immutable evidence tables with workspace authority and serialization triggers.
4. Add idempotent preparation, atomic apply claims, terminal evidence recording, and observability.
5. Add an internal-only HTTP and runtime boundary.
6. Add deterministic domain, filesystem, HTTP, and migration-contract tests.
7. Add a disposable PostgreSQL + local-Git lifecycle proving write gating, scope denial, idempotency, duplicate safety, stale hashes, start-time rechecks, rollback, workspace-wide serialization, immutable evidence, and source-repository isolation.
8. Run the full canonical CI chain on the exact final candidate before integration.
