# ADP-009 Implementation Plan

1. Extend new execution attempts with exact pre-claim evidence snapshot references.
2. Add PostgreSQL enforcement that evidence references match the exact claim state.
3. Update the budget-aware lease selector to select and persist exact evidence IDs atomically.
4. Add immutable one-per-attempt Task Context Pack storage.
5. Add deterministic repository path normalization and repository snapshot validation.
6. Build canonical pack content from immutable contract and execution evidence.
7. Hash pack content with the stable-JSON SHA-256 function.
8. Add lease-token proof, idempotent retry, and snapshot-drift conflict behavior.
9. Integrate pack observability into project and platform status.
10. Add internal-only pack create/read HTTP routes.
11. Add deterministic route/domain/schema tests.
12. Add a real PostgreSQL execution-evidence and Task Context Pack lifecycle verifier.
13. Run exact CI on the final candidate and integrate only the validated SHA.
