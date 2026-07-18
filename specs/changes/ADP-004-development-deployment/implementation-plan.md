# ADP-004 Implementation Plan

1. Make the Control Plane container build reproducible from the committed lockfile.
2. Add a development Compose stack with private PostgreSQL and private Control Plane networking.
3. Add Caddy as the sole public HTTPS ingress with persistent TLS state.
4. Add a placeholder-only environment template and operator runbook.
5. Add deterministic deployment topology/security tests.
6. Extend GitHub Actions to validate the Compose model and build the runtime image.
7. Preserve all existing exact-toolchain, migration, idempotency, and database invariant checks.
8. Integrate only after CI passes on the exact candidate revision.

Actual VPS provisioning, DNS changes, secret creation, and live launch remain external operations and are not authorized by this change.
