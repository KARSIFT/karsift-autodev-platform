# ADP-014 — Bounded Workspace Command Execution and Deterministic Evidence

## Objective

Add a governed local process-execution boundary inside an exact isolated repository workspace before any real implementation agent is connected.

## Authority model

A command may be prepared only when:

- the repository workspace exists and is exactly `MATERIALIZED`;
- the immutable workspace state version, path, mode, and plan evidence match;
- the latest selected project command-policy version is enabled;
- purpose, executable, exact argument vector, requested environment keys, timeout, output limit, and workspace command budget are allowed by that policy;
- `AUTOMATED_WRITE` is effective for WRITE workspaces.

Immediately before execution, PostgreSQL rechecks the exact workspace state and WRITE capability while atomically moving one run from `PREPARED` to `RUNNING`. Only the successful claimant may spawn the process.

## Runtime constraints

- `shell: false` only.
- Executables are bare command names selected by immutable policy.
- Arguments are exact allowlisted vectors in this version.
- Working directory is the exact stored isolated workspace path and must remain under the configured workspace root.
- The process receives only a minimal safe baseline environment plus explicitly policy-allowed variables.
- Provider, GitHub, SSH, cloud, and production credentials are not inherited.
- Timeout and output capture are bounded.
- Full stdout/stderr are not persisted; only byte counts, truncation flags, and SHA-256 digests are stored.

## Durable evidence

Each unique immutable command plan owns one durable run. A run transitions only:

`PREPARED → RUNNING → SUCCEEDED | FAILED | TIMED_OUT`

Terminal evidence is immutable and records exit code, signal, timeout outcome, duration, stdout/stderr digests and byte counts, truncation flags, sanitized spawn-error code, and a deterministic result hash.

## Activation boundary

ADP-014 remains A1. It activates no live AI provider call, remote repository credential, remote Git operation, commit, push, pull request creation, autonomous repair loop, independent AI verification, automatic merge, deployment, production release, or incident repair.
