# ADP-015 — Structured Workspace Mutation Plans and Atomic File Evidence

## Objective

Add the controlled text-file mutation boundary required before a live coding model may propose changes to an isolated repository workspace.

## Authority model

A mutation plan may be prepared only for an exact `MATERIALIZED` WRITE workspace whose immutable workspace plan, builder invocation, state version, path, and relevant-path scope still match. `AUTOMATED_WRITE` must be effective both when the plan is created and immediately before apply ownership is granted.

Each operation is structured as `CREATE`, `UPDATE`, or `DELETE`. UPDATE and DELETE require the exact SHA-256 of the current UTF-8 file. CREATE requires proof that the target does not exist. All paths must remain inside the Task Context Pack relevant-path scope.

## Filesystem boundary

- UTF-8 text files only.
- No symlink traversal or special-file mutation.
- Existing parent directories only.
- Full preflight occurs before the first write.
- Writes use same-directory temporary files and rename.
- Multi-file failures restore exact pre-apply bytes in reverse order.
- The isolated workspace source repository is never modified.

## Durable lifecycle

`PREPARED → APPLYING → APPLIED | FAILED`

Only one mutation run may be APPLYING for a workspace at a time. Identical plans are idempotent by deterministic plan hash. Terminal evidence records per-path before/after hashes and byte counts plus a deterministic result hash.

## Activation boundary

ADP-015 remains A1. No live AI provider is connected. No model receives direct filesystem authority. No remote Git operation, commit, push, pull request, independent AI verification, automatic merge, deployment, production release, or incident repair is activated.
