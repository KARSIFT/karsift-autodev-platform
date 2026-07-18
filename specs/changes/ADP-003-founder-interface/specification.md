# ADP-003 Specification — Founder Interface and ChatGPT Action Boundary

## Problem

The A1 Control Plane can durably record governed work, but its existing bearer credentials expose broad internal or founder-authority API access. Connecting either credential directly to a conversational interface would violate least privilege and create an unnecessary path from chat to governance-sensitive operations.

## Desired outcome

Create a dedicated founder-facing credential and action contract that allow ChatGPT to observe platform/project status and record founder requests without gaining execution, governance mutation, capability, deployment, or R4 decision authority.

## Functional requirements

### FR-01 — Dedicated credential

The service must require a third bearer token dedicated to the founder interface. It must be distinct from both the internal service token and the high-authority founder token.

### FR-02 — Server-side authorization

The founder-interface credential may access only:

- platform status;
- project status;
- founder request creation.

Authorization must be enforced by the Control Plane server, not only by omitting operations from the OpenAPI schema.

### FR-03 — Prohibited capabilities

The founder-interface credential must be unable to:

- create projects;
- record decisions, including R4 decisions;
- create or version Change Contracts;
- create tasks;
- create or transition workflow runs;
- disable or enable capability switches.

### FR-04 — Action schema

The repository must contain a version-controlled OpenAPI 3.1 schema exposing exactly the permitted founder-interface operations and bearer authentication.

### FR-05 — Self description

The running service must expose the same least-privilege action surface at `GET /openapi.json`, using the configured public service origin.

### FR-06 — Deployment boundary

The repository must document the remote HTTPS deployment requirements, secret boundaries, network exposure rules, and verification steps required before connecting ChatGPT.

## Security requirements

- The high-authority founder token must never be required for the ChatGPT Action integration.
- The internal service token must never be required for the ChatGPT Action integration.
- A compromised founder-interface token must not grant an execution path.
- Route authorization must happen before request bodies can trigger store mutations.
- All autonomous capabilities remain disabled.

## Product-interface decision

The first ChatGPT connection uses the existing HTTPS API through a GPT Action/OpenAPI contract. The Control Plane remains transport-neutral so a future MCP adapter can map to the same underlying policy and service operations without becoming a new source of authority.

## Definition of completion

ADP-003 is complete when deterministic tests and exact-environment CI prove the least-privilege route boundary and schema, and the change is integrated into `develop`. Actual public hosting and ChatGPT configuration require external infrastructure/domain credentials and are deployment operations, not repository code authority.
