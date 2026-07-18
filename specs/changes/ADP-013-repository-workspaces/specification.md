# ADP-013 — Isolated Repository Workspace and Automated Write Gate

## Objective

Create the repository-mutation boundary required before a real implementation worker can edit code.

The Control Plane must not hand a worker an unrestricted repository checkout. Every workspace is derived from immutable execution evidence, materialized at the exact Task Context Pack base commit, isolated from the source repository, and evaluated against the immutable relevant-path scope before its evidence can be accepted.

## Immutable workspace plan

A repository workspace plan is bound to:

- one prepared builder invocation;
- the matching execution attempt;
- the exact Task Context Pack ID and content hash;
- canonical repository identity;
- exact base branch and base commit SHA;
- normalized relevant paths from the Task Context Pack;
- workspace mode `READ_ONLY` or `WRITE`;
- workspace adapter key `local-git`.

The plan is canonically hashed. The workspace filesystem key and local branch name are deterministically derived from the plan hash so callers cannot choose arbitrary filesystem paths or branch names.

One builder invocation may have at most one immutable repository workspace plan.

## Independent write authority

`WRITE` workspace preparation requires effective project `AUTOMATED_WRITE` capability. This is separate from `AI_DISPATCH` and builder execution authority.

`AUTOMATED_WRITE` is rechecked when final workspace evidence is recorded. If write authority is removed after materialization, finalization fails closed until authority is restored or the workspace is abandoned.

`READ_ONLY` workspace plans do not require `AUTOMATED_WRITE`, but any detected file change causes a scope violation.

Permanent global `AUTOMATED_WRITE` remains disabled in ADP-013. Tests may temporarily enable it only for disposable CI projects.

## Local-only adapter

The initial repository adapter is `local-git`.

It accepts only a normalized relative source-repository path beneath the configured `REPOSITORY_SOURCE_ROOT` and creates workspaces only beneath `REPOSITORY_WORKSPACE_ROOT`.

It does not accept a remote URL, configure credentials, fetch from a network service, push, or modify the source repository.

Materialization:

1. verifies the source is a local Git repository;
2. verifies the exact Task Context Pack base commit exists;
3. clones into the deterministic isolated workspace path without hardlinks;
4. checks out the exact base commit;
5. creates a local deterministic KARSIFT branch;
6. verifies workspace `HEAD` equals the locked base commit.

## Diff and scope evidence

Finalization collects changed and untracked paths from Git and produces deterministic per-path content hashes. Symlinks are hashed by link target rather than followed outside the workspace.

Scope rules are fail-closed:

- `READ_ONLY`: no changed path is permitted;
- `WRITE`: a changed path must equal an allowed relevant path or be its descendant;
- an empty WRITE scope permits no changes.

The final evidence contains base SHA, head SHA, normalized changed paths, per-path statuses/content hashes, scope validity, violations, and a deterministic evidence hash.

Workspace plans and final evidence are append-only. A workspace transitions through a bounded lifecycle and successful or scope-violating finalization cleans up the disposable local checkout after durable evidence is recorded.

## Filesystem boundaries

The source and workspace roots are separate configuration values. The local adapter rejects source traversal outside the source root and workspace paths outside the workspace root.

The runtime container includes the Git executable and dedicated repository/workspace directories, but ADP-013 does not provision or mount any real project repository or credential.

## Activation boundary

ADP-013 does not:

- call Codex or another external AI provider;
- configure provider or GitHub credentials;
- clone or fetch from a remote URL;
- commit, push, or open a pull request;
- activate permanent global `AI_DISPATCH` or `AUTOMATED_WRITE`;
- perform independent verification;
- merge, deploy, or release production changes.

A later governed change must connect a scoped remote repository credential and a real builder to this workspace boundary.
