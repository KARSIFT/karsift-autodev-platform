# Implementation Plan

1. Add deterministic requested-path validation, protected-path policy, request hashing, and snapshot hashing.
2. Add a bounded root-confined UTF-8 filesystem capturer with deterministic directory expansion and drift rechecks.
3. Add PostgreSQL request, capture-run, and immutable snapshot tables.
4. Add capture leases that mutually exclude active workspace commands and mutations, and update command/mutation start gates to honor active captures.
5. Add idempotent request preparation, atomic capture claims, immutable snapshot persistence, and observability.
6. Add an internal-only HTTP and runtime boundary.
7. Add deterministic domain, filesystem, HTTP, and migration-contract tests.
8. Add a disposable PostgreSQL + local-Git lifecycle proving capture idempotency, protected/scope denial, command/mutation mutual exclusion, immutable evidence, and global capability safety.
9. Run the full canonical CI chain on the exact final candidate before integration.
