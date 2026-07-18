# ADP-016 — Immutable Workspace Read Context Snapshots

## Objective

Create the bounded immutable source-context artifact required before any external coding model may receive repository content.

## Authority model

A read-context request binds to one exact `MATERIALIZED` repository workspace, immutable workspace plan, builder invocation, Task Context Pack hash, workspace state version, workspace path, relevant-path scope, and explicit requested paths.

Capture ownership transitions one durable run from `PREPARED` to `CAPTURING`. PostgreSQL rejects the capture if a workspace command is `RUNNING` or a workspace mutation is `APPLYING`. Command and mutation start transitions also reject while a capture is active, producing a short mutually exclusive workspace I/O boundary.

## Filesystem boundary

- Explicit requested paths only.
- Directories expand recursively and deterministically.
- Requested paths must remain inside immutable relevant-path scope.
- UTF-8 regular files only.
- Repository metadata, local-only protected paths, symlinks, special files, traversal, and workspace-root escape fail closed.
- File count, per-file bytes, and total bytes are bounded.
- The expanded file set is enumerated twice and every file is re-hashed after capture; any drift rejects the snapshot.

## Durable snapshot

Each captured file stores repository-relative path, UTF-8 content, SHA-256 hash, and byte count in deterministic lexical order. The canonical immutable snapshot binds the exact request evidence, file set, total bytes, and content into one reproducible snapshot hash.

## Activation boundary

ADP-016 remains A1. It makes bounded source content available only through the internal Control Plane. No external AI provider is called, no model receives filesystem authority, and no remote Git, repository publication, automatic merge, deployment, production release, or incident-repair capability is activated.
