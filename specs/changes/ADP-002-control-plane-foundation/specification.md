# ADP-002 Specification

## Problem

The platform has an approved architecture and governance baseline, but it has no executable durable Control Plane. Work still depends on chat and repository artifacts rather than a service that can persist workflow state, requests, decisions, contracts, tasks, and capability state.

## Desired outcome

Create the smallest executable A0 → A1 Control Plane that can durably coordinate work for multiple explicitly identified projects without activating autonomous AI execution.

## Functional requirements

### FR-01 — Project registry

The Control Plane must record an explicit project identity, repository, default branch, and integration branch.

### FR-02 — Founder requests and decisions

The Control Plane must record founder requests and governance decisions with project scope and actor identity.

### FR-03 — Immutable Change Contract versions

A Change Contract must have a stable identity and append-only immutable versions. Each version must have a deterministic SHA-256 content hash.

### FR-04 — Tasks and workflow runs

The Control Plane must record tasks and workflow runs. Workflow transitions must use an explicit state machine, concurrency version, and transactional audit event.

### FR-05 — Persistent capability kill switches

Autonomous capabilities must be represented by persistent global or project-scoped switches. All autonomous capabilities must default to disabled.

ADP-002 must not expose an API path that enables these capabilities.

### FR-06 — Auditability

Important write operations must append an audit event in the same transaction as the state change.

Change Contract versions and audit events must be append-only at the database layer.

### FR-07 — Authenticated internal API

All `/v1/*` endpoints must require a bearer token. The health endpoint may be unauthenticated.

### FR-08 — Status reporting

The API must expose platform status and project status including current activation level, workflow state, and capability state.

### FR-09 — Provider-neutral future boundary

The codebase must define a provider-neutral worker adapter interface without implementing or activating a worker.

## Non-functional requirements

- Target Node.js 24 LTS.
- Use PostgreSQL 18 as the durable state store.
- Keep runtime dependencies minimal.
- Use deterministic TypeScript compilation and Node's built-in test runner.
- Use parameterized SQL.
- Keep safety-critical transition logic in ordinary TypeScript.
- Remain runnable in a container-oriented local setup.

## Security requirements

- No AI provider credentials.
- No production credentials.
- No autonomous write or dispatch capability.
- Founder and internal-service API tokens must be separate, at least 32 characters, and non-interchangeable.
- Request body size must be bounded.
- Internal-service credentials must not be able to impersonate founder authority or record R4 decisions.
- Capability enablement must be impossible through ADP-002 API code.
- Project identity must be explicit on project-owned workflow records.

## Completion

ADP-002 is complete when the implementation builds, deterministic domain/security tests pass, the migration and local run path are documented, and the exact candidate is proposed in a draft PR to `develop`.
