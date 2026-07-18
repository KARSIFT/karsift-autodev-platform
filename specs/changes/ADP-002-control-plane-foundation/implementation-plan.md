# ADP-002 Implementation Plan

## Sequence

1. Pin the supported runtime and dependency versions.
2. Add the TypeScript build configuration and local environment template.
3. Add PostgreSQL 18 local container configuration.
4. Add the initial durable schema and append-only database protections.
5. Implement workflow state and capability policies in ordinary TypeScript.
6. Implement the PostgreSQL store with transactional audit events.
7. Add the bearer-authenticated internal API.
8. Add the provider-neutral worker adapter interface with dispatch inactive.
9. Add deterministic domain and security tests.
10. Validate the candidate locally.
11. Propose the exact candidate through a draft PR to `develop`.

## Explicit activation boundary

ADP-002 changes the technical activation level from A0 to A1 only.

It does not activate:

- autonomous repository writes;
- AI dispatch;
- automatic merge;
- deployment;
- production release;
- incident repair.

## Rollback

Revert the ADP-002 integration commit and stop the Control Plane process. No automated downstream capability depends on ADP-002 at the time of initial integration.
