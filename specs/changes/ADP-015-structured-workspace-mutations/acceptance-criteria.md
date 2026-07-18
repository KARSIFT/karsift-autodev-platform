# Acceptance Criteria

ADP-015 is complete only when the exact PR head proves all of the following:

- Mutation plans and terminal evidence are immutable.
- Plans bind to one exact MATERIALIZED WRITE workspace and builder/workspace evidence.
- `AUTOMATED_WRITE` is required at plan creation and apply start.
- CREATE, UPDATE, and DELETE enforce exact before-state semantics.
- Every operation stays inside the immutable relevant-path scope.
- Duplicate paths, traversal, symlinks, special files, non-UTF-8 files, oversized content, and missing parent directories fail closed.
- Identical plan retries return the same durable run.
- Concurrent apply requests execute one plan at most once.
- Only one distinct mutation may be APPLYING in a workspace at a time.
- Multi-file apply failure restores exact pre-apply bytes.
- Terminal evidence contains deterministic per-path before/after hashes and byte counts.
- Founder and founder-interface credentials cannot operate the mutation API.
- The runtime image builds and all twelve migrations apply idempotently.
- All prior Control Plane lifecycle verifiers still pass.
- The dedicated disposable PostgreSQL + local-Git mutation lifecycle passes.
- Global autonomous capability switches remain disabled.
- No live AI provider, remote Git, commit, push, pull request, merge, deployment, or production capability is activated.
