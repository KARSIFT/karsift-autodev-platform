# ADP-002 Exact-Environment Validation

## Purpose

ADP-002 must not be integrated based only on local compilation with substitute tooling. The exact candidate must be validated in a reproducible CI environment before the pull request is considered ready for integration.

## Pinned validation environment

- Node.js: `24.18.0`
- TypeScript: `7.0.2`
- PostgreSQL: `18.4`
- Dependency versions: exact versions declared by `package.json`, resolved into a committed `package-lock.json`

## Required deterministic evidence

The CI candidate must prove all of the following:

1. Dependencies can be resolved and installed from the generated lockfile.
2. Strict TypeScript compilation succeeds.
3. The deterministic unit and security tests pass.
4. The foundation migration applies successfully to a real PostgreSQL 18.4 database.
5. Re-running the migration is idempotent.
6. The expected foundation tables and migration record exist.
7. All global autonomous capability switches remain disabled.
8. `change_contract_versions` rejects mutation.
9. `audit_events` rejects mutation.
10. Cross-project references are rejected by database constraints.

## Dependency lock promotion

The first successful exact-environment CI run may generate `package-lock.json` as an artifact. The lockfile must then be committed to the ADP-002 branch and CI rerun using the committed lockfile before final integration review.

## Authority boundary

Passing this validation proves only the A0 → A1 Control Plane foundation. It does not activate autonomous worker dispatch, automatic merge, deployment, production release, or incident repair.
