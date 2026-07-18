# ADP-011 — Controlled Builder Runtime Contract

## Objective

Create the durable, provider-neutral execution contract required before a real implementation agent such as Codex can be connected.

## Runtime contract

A builder invocation may only be prepared for an active, unexpired execution attempt that already has an immutable Task Context Pack and exact provider-dispatch evidence.

The invocation plan is immutable and bound to:

- one execution attempt;
- one Task Context Pack ID and content hash;
- one provider dispatch decision and provider key;
- capability `CODE_BUILDER`;
- one adapter key and side-effect mode;
- immutable maximum turns, retry budget, command budget, and timeout.

One execution attempt may have at most one builder invocation plan and one builder invocation. Identical preparation retries are idempotent. A retry that changes the immutable plan conflicts.

## Initial adapter

ADP-011 registers only the `dry-run` adapter with side-effect mode `NONE`.

The dry-run adapter:

- makes no external provider call;
- performs no repository mutation;
- executes no shell command;
- records deterministic success evidence through the same adapter/service/store path future workers will use.

PostgreSQL constrains ADP-011 plans to `adapter_key = dry-run` and `side_effect_mode = NONE`. A future governed migration is required before any real builder adapter or repository-write mode can be used.

## Start-time gates

Starting the dry-run runtime rechecks:

- the execution lease is still active and unexpired;
- the exact linked provider readiness observation is still healthy and unexpired;
- effective `AI_DISPATCH` capability is enabled;
- the registered adapter side-effect mode matches the immutable plan.

`AUTOMATED_WRITE` remains disabled and is not needed by the dry-run adapter because it cannot mutate a repository.

## Results and evidence

Builder results are append-only and may be written only for a running invocation. PostgreSQL and the domain layer enforce the immutable plan limits on turns, commands, and duration. Result evidence is deterministically hashed. Identical terminal completion retries return the same evidence; different terminal evidence conflicts.

## Known pre-activation requirements

Before connecting a real external builder in a later governed change, the platform must additionally prove:

1. atomic external-dispatch ownership so concurrent run requests cannot call a provider twice;
2. refreshed provider readiness so a newer provider observation can supersede the observation linked to the original dispatch decision before the external call;
3. provider credentials and actual usage/cost evidence handling;
4. a separately capability-gated repository sandbox/worktree and `AUTOMATED_WRITE` path.

These requirements are deliberately out of scope for the no-side-effect ADP-011 runtime.

## Activation boundary

ADP-011 does not call OpenAI, Codex, Anthropic, Claude, or any other external AI provider. It does not configure credentials, create a repository checkout, execute implementation commands, write code, commit, push, open a pull request, verify a change, merge, deploy, or release.
