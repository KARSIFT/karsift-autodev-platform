# Implementation Plan

1. Add deterministic action-specific proposal validation and request/proposal hashing.
2. Add a provider-neutral proposal adapter registry and deterministic fixture adapter.
3. Add PostgreSQL proposal request, run, and immutable evidence tables bound to builder/source evidence.
4. Reuse ADP-012 active READY dispatch claims for proposal generation ownership and provider revalidation.
5. Add idempotent request preparation, atomic generation claims, immutable terminal evidence, and observability.
6. Add an internal-only HTTP and runtime boundary.
7. Add deterministic domain, HTTP, and migration-contract tests.
8. Add a real PostgreSQL + local-Git lifecycle proving source snapshot binding, missing-dispatch rejection, concurrent duplicate safety, fixture-only no-external-call evidence, immutability, and dispatch-claim completion.
9. Run the full canonical CI chain on the exact final candidate before integration.
