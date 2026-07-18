# Acceptance Criteria

ADP-016 is complete only when the exact PR head proves all of the following:

- Read-context requests and snapshots are immutable.
- Requests bind to exact MATERIALIZED workspace, workspace plan, builder, Task Context Pack, state version, path, and relevant scope evidence.
- Requested paths outside scope and protected paths fail closed.
- Directory expansion is deterministic and captures UTF-8 regular files only.
- Symlinks, special files, traversal, root escape, non-UTF-8 content, excess file count, per-file size, and total size fail closed.
- The file set is enumerated twice and every file is re-hashed to detect capture-time drift.
- Identical request retries return the same durable run and snapshot.
- Concurrent capture requests for one workspace cannot both own the capture lease.
- A RUNNING workspace command blocks capture.
- An APPLYING workspace mutation blocks capture.
- An active CAPTURING read context blocks new command and mutation starts.
- Founder and founder-interface credentials cannot operate read-context APIs.
- The runtime image builds and all thirteen migrations apply idempotently.
- All prior Control Plane lifecycle verifiers still pass.
- The dedicated disposable PostgreSQL + local-Git read-context lifecycle passes.
- Global autonomous capability switches remain disabled.
- No external AI provider, remote Git, publication, merge, deployment, or production capability is activated.
