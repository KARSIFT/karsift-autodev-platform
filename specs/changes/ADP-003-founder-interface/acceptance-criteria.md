# ADP-003 Acceptance Criteria

## AC-01 — Credentials are separated

Given Control Plane configuration,
when tokens are loaded,
then internal, founder, and founder-interface bearer tokens must all be present, strong, and distinct.

## AC-02 — Status reads are permitted

Given the founder-interface credential,
when platform or project status is requested,
then the request succeeds.

## AC-03 — Founder request creation is permitted

Given the founder-interface credential,
when a founder request is submitted for a managed project,
then the request is durably recorded under founder identity without authorizing implementation.

## AC-04 — Execution and governance mutation are denied

Given the founder-interface credential,
when it attempts project creation, decision recording, Change Contract creation/versioning, task creation, workflow creation/transition, or capability mutation,
then the server returns `403` before the store mutation is invoked.

## AC-05 — OpenAPI surface is narrow

Given the checked-in founder action schema and `GET /openapi.json`,
when their paths are inspected,
then they expose only platform status, project status, and founder request creation.

## AC-06 — High-authority credentials are not disclosed

Given the deployment and ChatGPT connection documentation,
when the integration is configured,
then only the founder-interface token is used by the custom GPT.

## AC-07 — No autonomy is activated

Given ADP-003 is merged,
when capability state is inspected,
then AI dispatch, automated writes, automatic merge, deployment, production release, and incident repair remain disabled.

## AC-08 — Deterministic validation passes

Given the exact candidate revision,
when TypeScript compilation and the deterministic test suite run,
then all tests pass without requiring an AI service.
