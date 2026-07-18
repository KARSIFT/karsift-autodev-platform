# ADP-002 Acceptance Criteria

## AC-01 — Durable project identity

Given a new managed project,
when it is registered,
then the Control Plane records its project identity and repository/branch mapping.

## AC-02 — Durable governance records

Given an authenticated internal caller,
when requests, decisions, Change Contracts, tasks, and workflow runs are created,
then they are persisted with explicit project scope and audit evidence.

## AC-03 — Change Contract versions are immutable

Given a Change Contract version,
when an update or delete is attempted at the database layer,
then the database rejects the mutation.

## AC-04 — Workflow transitions are bounded

Given a workflow run,
when a valid transition with the current state version is requested,
then it succeeds atomically and increments the state version.

When an invalid transition or stale expected version is requested,
then the operation fails.

## AC-05 — Autonomous capabilities remain disabled

Given the ADP-002 service,
when capability state is inspected,
then all autonomous capabilities default to disabled and no API route can enable them.

## AC-06 — Internal API is authenticated

Given a `/v1/*` route,
when the bearer token is missing or wrong,
then the request is rejected.

## AC-07 — Founder authority is non-forgeable by the internal credential

Given the internal service credential,
when it attempts to record an R4 decision,
then the API rejects the request.

Given the founder credential,
when it records an R4 decision,
then the audit actor is the configured founder identity.

## AC-08 — Status is observable

Given a healthy database,
when platform or project status is requested,
then the service reports workflow and capability state without requiring direct database access.

## AC-09 — Worker providers are not activated

Given the source tree,
when worker integration is inspected,
then only a provider-neutral interface exists and `WORKER_DISPATCH_ACTIVE` remains false.

## AC-10 — Deterministic checks pass

Given the candidate revision,
when the TypeScript build and built-in Node tests are executed,
then they complete successfully without requiring AI services.
