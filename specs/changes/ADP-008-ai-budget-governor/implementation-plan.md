# ADP-008 Implementation Plan

1. Define deterministic execution classes and budget decision rules.
2. Add project budget policies, append-only exact-state budget decisions, and cost reservations.
3. Add automatic stale-reservation release on queue state changes.
4. Add PostgreSQL execution-attempt budget and AI-dispatch capability gates.
5. Add reservation commit, release, and settlement enforcement around execution attempts.
6. Implement the PostgreSQL AI Budget Governor with project-level row locking.
7. Add a budget-aware lease selector that skips work without current financial authority.
8. Integrate budget observability into project/platform status.
9. Add least-privilege budget policy, decision, and settlement HTTP routes.
10. Update existing queue/freshness lifecycle verifiers for mandatory deterministic budget approval.
11. Add a dedicated real PostgreSQL budget/concurrency lifecycle verifier.
12. Run exact CI on the final candidate and integrate only the validated SHA.
