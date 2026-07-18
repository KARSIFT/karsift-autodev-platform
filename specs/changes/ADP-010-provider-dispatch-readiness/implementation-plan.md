# ADP-010 Implementation Plan

1. Define provider capacity states and deterministic ordered-route fallback semantics.
2. Persist project routing policies, append-only capacity observations, and append-only exact-state dispatch decisions.
3. Add PostgreSQL defense-in-depth so AI attempts require the latest valid READY provider evidence while deterministic attempts remain provider-free.
4. Make AI lease selection consume provider readiness before creating an attempt.
5. Snapshot provider dispatch evidence onto the execution attempt.
6. Upgrade Task Context Packs to schema v2 and embed immutable provider evidence.
7. Add least-privilege internal provider routing/readiness HTTP operations and status observability.
8. Preserve earlier budget and execution lifecycle coverage under the new gate.
9. Add deterministic schema, domain, and HTTP tests plus a real PostgreSQL provider lifecycle verifier.
10. Run the entire exact-environment CI chain and integrate only one fully validated head revision.
