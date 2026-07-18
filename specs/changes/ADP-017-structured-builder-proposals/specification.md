# ADP-017 — Structured Builder Proposal Contract and Immutable Proposal Evidence

## Objective

Create the provider-neutral structured proposal boundary that a future coding model must use instead of receiving direct command, filesystem, or repository-publication authority.

## Immutable input

Each proposal request binds the exact builder invocation and plan, execution attempt, Task Context Pack content/hash, selected provider dispatch decision, immutable workspace read-context snapshot content/hash, and relevant-path scope into one deterministic input hash.

## Proposal contract

A proposal has exactly one action:

- `COMPLETE` — no follow-on action payload.
- `REQUEST_CONTEXT` — requested repository-relative paths only.
- `REQUEST_COMMANDS` — bounded structural command requests only.
- `PROPOSE_MUTATIONS` — bounded structured CREATE/UPDATE/DELETE operations only.
- `BLOCKED` — one bounded blocking reason only.

Action payloads are mutually exclusive. Context paths must remain inside immutable relevant scope. Mutation proposals must already satisfy ADP-015 structural and scope rules. Command proposals are inert structural requests and do not bypass ADP-014 policy or execution authority.

## Dispatch authority

Proposal generation reuses the existing ADP-012 builder dispatch claim. A proposal run may enter `GENERATING` only with an active, unexpired claim and exact READY provider revalidation for the provider already frozen into the builder plan.

## Runtime boundary

ADP-017 registers only the deterministic `fixture-proposal` adapter. PostgreSQL constrains proposal requests to that adapter and terminal evidence to `external_provider_called = false` with no provider request identifier. A future live provider adapter must be introduced by a later governed change.

## Durable lifecycle

`PREPARED → GENERATING → GENERATED | FAILED`

Proposal requests and terminal evidence are immutable. Identical immutable inputs are idempotent. Only one proposal generation may be active for a builder invocation at a time.

## Activation boundary

ADP-017 remains A1. No live AI provider call, direct shell execution, direct filesystem mutation, automatic execution of proposed actions, remote Git operation, repository publication, independent verification, automatic merge, deployment, production release, or incident repair is activated.
