# ADP-004 Specification — Development VPS Deployment Package

## Problem

The A1 Control Plane and least-privilege founder interface are tested in CI but are not yet packaged for a persistent remotely reachable development environment. A deployment assembled ad hoc could accidentally expose PostgreSQL, bypass the HTTPS boundary, drift from the committed dependency lock, or mishandle credentials.

## Desired outcome

Provide a reproducible, provider-neutral Docker deployment package for a single development VPS. Only the HTTPS ingress is publicly exposed; PostgreSQL remains private; the Control Plane is built from the committed lockfile; secrets are supplied externally at runtime.

## Functional requirements

### FR-01 — Reproducible application image

The runtime image must use the pinned Node runtime and `npm ci` with the committed `package-lock.json` for both build and production dependencies.

### FR-02 — Private state

PostgreSQL must have no host port mapping and must communicate with the Control Plane on a private internal Docker network.

### FR-03 — HTTPS ingress

Caddy is the only service with public ports. It terminates HTTPS and proxies to the private Control Plane service.

### FR-04 — Persistent state

PostgreSQL data and Caddy certificate/configuration state must use named persistent volumes.

### FR-05 — Secret injection

Database passwords and all Control Plane bearer credentials must be required runtime environment values and must not be committed to Git.

### FR-06 — Health and startup ordering

PostgreSQL and the Control Plane must expose health signals sufficient for dependency ordering. The Control Plane container must include a runtime health check.

### FR-07 — Operator runbook

The repository must document configuration, migration, startup, external verification, and the ChatGPT credential boundary.

### FR-08 — CI validation

CI must validate the Compose model with representative non-production values, build the real runtime container, run deterministic tests, and preserve the existing PostgreSQL migration/invariant checks.

## Security requirements

- PostgreSQL is not publicly reachable.
- The Control Plane application port is not published to the host.
- Only ports 80/443 are publicly mapped by the deployment package.
- The founder-interface credential is the only Control Plane credential intended for ChatGPT.
- No deployment secret is stored in repository files.
- This package does not grant GitHub or an AI agent permission to deploy a server.

## Definition of completion

ADP-004 is complete when the deployment package, security invariant test, runbook, and CI deployment gates pass on the exact candidate revision and the change is integrated into `develop`. Actual VPS provisioning, DNS configuration, secret creation, and live launch remain external deployment operations.
