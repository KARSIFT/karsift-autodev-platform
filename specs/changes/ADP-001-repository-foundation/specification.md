# ADP-001 Specification

## Problem

KARSIFT needs a reusable autonomous-development platform before product-specific applications are designed and implemented. The platform repository currently has no durable operating rules, no canonical platform boundary, and no governed change-package baseline.

Without this foundation, future AI workers would depend too heavily on chat context and could make inconsistent decisions about authority, scope, sources of truth, and activation state.

## Desired outcome

Establish a minimal governed repository foundation that allows the next change to implement the first Control Plane slice safely and consistently.

## In scope

- Define the repository-wide authority hierarchy and agent boundaries.
- Define the reusable KARSIFT Autodev Platform boundary.
- Establish `main`, `develop`, and bounded change-branch conventions.
- Establish the initial ADP change-package format.
- Define the minimum Control Plane foundation to be implemented next.
- Preserve the VocaNova autonomous-development architecture principles while removing VocaNova-specific product assumptions.

## Out of scope

- Implementing a production-ready Control Plane.
- Dispatching Codex automatically.
- Automating Claude verification.
- Enabling automatic or autonomous merge.
- Deploying preview, staging, or production environments.
- Giving AI workers production credentials.
- Building any customer-facing product feature.

## Functional requirements

### FR-01 — Durable repository rules

The repository must contain canonical agent instructions defining authority, source-of-truth rules, branch discipline, separation of duties, and current activation boundaries.

### FR-02 — Reusable platform boundary

The repository must define the automation platform as a separate shared system capable of managing multiple isolated KARSIFT projects.

### FR-03 — Governed change identity

Meaningful platform changes must use stable `ADP-###` identifiers and bounded change branches.

### FR-04 — Control Plane foundation definition

The next implementation slice must have enough durable specification to build a minimal A0 → A1 Control Plane foundation containing at least:

- authenticated internal API boundary;
- PostgreSQL-backed durable state;
- project registry;
- founder requests;
- decisions;
- change contracts and immutable versions;
- tasks;
- workflow runs;
- audit events;
- health/status endpoint;
- kill-switch state for automated write capabilities.

### FR-05 — No premature autonomy

No autonomous AI execution, automatic merge, deployment, or production authority may be activated by this change.

### FR-06 — Multi-project isolation baseline

The architecture must require explicit project identity and project-scoped repository access, policies, budgets, credentials, and environment boundaries.

## Non-functional requirements

- The initial platform must remain simple enough to run on low-cost infrastructure.
- PostgreSQL should be the initial durable workflow-state store.
- Core safety-critical state transitions should be implemented in ordinary application code, not exist only inside n8n workflows.
- External integrations must be designed around narrow typed operations rather than generic shell or master-credential access.
- Important state transitions and privileged actions must be auditable.
- The architecture must permit replacement of AI providers without redesigning the platform core.

## Security requirements

- Use least privilege.
- Separate human identities from machine identities.
- Do not provide implementation workers with production credentials.
- Do not allow any agent to approve its own implementation.
- Do not allow an automated system to expand its own authority.
- Preserve independent kill switches for later automated capabilities.

## Definition of completion

ADP-001 is complete when the repository contains the approved bootstrap rules, platform charter, machine-readable change record, implementation-ready definition for the next Control Plane slice, and acceptance criteria, all reviewed through a pull request targeting `develop`.
