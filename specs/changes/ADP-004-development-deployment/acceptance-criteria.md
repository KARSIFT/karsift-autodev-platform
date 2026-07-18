# ADP-004 Acceptance Criteria

## AC-01 — Runtime build is locked

Given the Control Plane Dockerfile,
when the application image is built,
then dependencies are installed with `npm ci` from the committed lockfile.

## AC-02 — PostgreSQL is private

Given the development Compose model,
when service port mappings are inspected,
then PostgreSQL has no public host port and is attached to an internal backend network.

## AC-03 — Control Plane is private behind ingress

Given the development Compose model,
when the Control Plane service is inspected,
then port 8080 is exposed only to Docker networks and is not published to the host.

## AC-04 — HTTPS ingress is the public boundary

Given the development stack,
when public port mappings are inspected,
then Caddy is the only service publishing ports 80 and 443 and proxies to the Control Plane.

## AC-05 — Persistent state exists

Given the development stack,
when volumes are inspected,
then PostgreSQL data and Caddy certificate/configuration state use persistent named volumes.

## AC-06 — Secrets remain external

Given repository deployment artifacts,
when configuration is inspected,
then only placeholders are stored and required credentials are injected through runtime environment variables.

## AC-07 — Operator path is documented

Given a Docker-capable VPS and DNS hostname,
when an operator follows the runbook,
then the documented sequence covers configuration, migration, startup, HTTPS verification, and founder-interface boundary checks.

## AC-08 — Deployment invariants are deterministic

Given the candidate revision,
when deterministic tests run,
then they fail if PostgreSQL or the Control Plane gains a public port, HTTPS ingress is removed, the private backend network is removed, or the container stops using the committed lockfile.

## AC-09 — Exact-environment CI passes

Given the exact candidate revision,
when GitHub Actions runs,
then the Compose configuration parses, the runtime image builds, deterministic tests pass, migrations are idempotent, and PostgreSQL foundation invariants pass.

## AC-10 — No deployment authority is activated

Given ADP-004 is integrated,
when capability state is inspected,
then AI dispatch, automatic merge, autonomous deployment, production release, and incident repair remain disabled.
