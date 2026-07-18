# ADP-012 — Atomic External Dispatch Claim and Provider Revalidation

## Objective

Add the final duplicate-safety and freshness boundary required before a future builder adapter can call an external AI provider.

A builder invocation must not reach its adapter merely because it was prepared and previously had provider readiness. Immediately before adapter execution, one worker must atomically own the dispatch and the selected provider must be revalidated against the latest available capacity observation.

## Dispatch ownership

Each builder invocation uses a stable dispatch idempotency key derived from its immutable builder invocation plan hash:

`builder-dispatch:<plan-hash>`

A durable dispatch claim records the invocation, immutable plan, claim owner, opaque claim token, lease expiry, heartbeat, and lifecycle status.

At most one unexpired `ACTIVE` claim may exist for a builder invocation. Concurrent run requests therefore cannot both obtain execution authority. A caller that does not newly acquire the active claim must not invoke the adapter.

Expired claims are reconciled to `EXPIRED` before a new claim is acquired. Recovery uses the same stable dispatch idempotency key, allowing future real provider adapters to use provider-side idempotency or reconciliation before retrying an uncertain external side effect.

## Immediate provider revalidation

Claim acquisition reads the latest provider-capacity observation for the provider selected by the immutable builder plan and `CODE_BUILDER` capability.

The latest observation, rather than the observation captured by an earlier dispatch-readiness decision, controls immediate execution readiness:

- fresh `HEALTHY` → `READY`;
- fresh `QUOTA_EXHAUSTED` → wait reason `QUOTA`;
- missing, stale, `DEGRADED`, or `UNAVAILABLE` → wait reason `PROVIDER_UNAVAILABLE` with an explicit reason code.

The revalidation result is append-only evidence bound to the dispatch claim. A non-ready revalidation causes the newly created claim to be released before the adapter can run.

## Database enforcement

PostgreSQL enforces:

- one active claim per invocation;
- stable plan-derived dispatch idempotency keys;
- claim evidence matches the immutable invocation plan;
- valid claim transitions from `ACTIVE` only;
- append-only provider revalidation evidence;
- revalidation provider evidence matches the immutable plan;
- `PREPARED → RUNNING` requires an active, unexpired dispatch claim with `READY` revalidation.

Therefore an internal caller cannot bypass the claim/revalidation protocol merely by invoking the builder start operation directly.

## Runtime behavior

The builder runtime service:

1. attempts to acquire a dispatch claim;
2. returns without executing the adapter when the claim is already owned or current provider readiness is not `READY`;
3. starts the builder invocation only after the claim is acquired;
4. passes the stable dispatch idempotency key into the provider-neutral adapter input;
5. completes the builder invocation and dispatch claim after a valid adapter result;
6. releases the claim when start-time checks fail.

The internal API also exposes claim heartbeat and explicit release for future long-running adapters.

## Current adapter and activation boundary

The only registered builder adapter remains `dry-run`, with side-effect mode `NONE`.

ADP-012 does not:

- call OpenAI, Codex, Anthropic, Claude, or another provider;
- configure provider credentials;
- create a repository checkout or worktree;
- mutate code;
- execute implementation commands;
- commit, push, or open a pull request;
- activate `AUTOMATED_WRITE`;
- activate global `AI_DISPATCH`;
- verify, merge, deploy, or release a change.

## Future real-provider requirement

A real provider adapter must treat the stable dispatch idempotency key as part of its side-effect reconciliation contract. If the process loses certainty after an external request, it must reconcile provider state before repeating the request. ADP-012 establishes the durable ownership and idempotency evidence needed for that later governed adapter, but performs no external side effect itself.
