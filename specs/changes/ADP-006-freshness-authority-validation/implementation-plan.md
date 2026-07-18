# ADP-006 Implementation Plan

1. Add append-only work-validation storage bound to queue state and exact Change Contract identity/hash.
2. Add deterministic freshness/authority evaluation rules.
3. Add a PostgreSQL validation store that updates queue state and writes audit evidence atomically.
4. Require current successful validation evidence in the lease claim query.
5. Re-check current project/task/contract facts inside the claim transaction to prevent post-validation authority drift.
6. Add an authenticated internal validation API while preserving the founder-interface deny boundary.
7. Add validation outcome observability to project/platform status.
8. Extend deterministic migration/API/domain tests.
9. Update existing queue verification to revalidate after state-version changes.
10. Add a dedicated real PostgreSQL freshness/authority lifecycle verifier to CI.
11. Integrate only after all existing and new gates pass on the exact candidate revision.

No authority-granting policy, AI provider, or autonomous dispatch capability is introduced by this change.
