# ADP-012 Implementation Plan

1. Define stable plan-derived dispatch idempotency and bounded dispatch-claim leases.
2. Add durable dispatch claims with one-active-claim enforcement, heartbeats, completion, release, and expiry recovery.
3. Add append-only provider revalidation evidence bound to each claim.
4. Revalidate the selected provider using the latest capacity observation immediately before adapter execution.
5. Add PostgreSQL enforcement that builder invocation start requires an active, unexpired, `READY` dispatch claim.
6. Pass the stable dispatch idempotency key into the provider-neutral builder adapter contract.
7. Change the builder runtime service so only a newly acquired claim owner can execute the adapter.
8. Add internal-only heartbeat and release operations for future long-running adapters.
9. Preserve the existing dry-run adapter and immutable builder-result evidence format.
10. Prove concurrent run requests execute the adapter at most once.
11. Prove unavailable/expired latest provider capacity prevents adapter execution.
12. Prove claim expiry recovery preserves the stable dispatch idempotency key.
13. Run the full exact-environment nine-migration CI chain and integrate only one fully validated head revision.
