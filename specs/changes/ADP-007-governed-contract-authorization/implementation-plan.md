# ADP-007 Implementation Plan

1. Define deterministic governance-fact parsing and R0–R4 authorization policy.
2. Add append-only exact-version authorization decision storage.
3. Add effective-authorization SQL function and execution-attempt database trigger.
4. Implement the authorization store and audit evidence.
5. Integrate authorization observability into project/platform status.
6. Make freshness consume effective authorization evidence rather than mutable status.
7. Attach a least-privilege authorization HTTP route without changing the mature base router.
8. Convert existing queue/freshness verifiers to governed authorization.
9. Add a dedicated PostgreSQL authorization lifecycle verifier.
10. Run exact CI on the final candidate and integrate only the validated SHA.
