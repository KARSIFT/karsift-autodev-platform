# KARSIFT Autodev Platform — Agent Rules

These instructions apply repository-wide.

## 1. Purpose

This repository contains the reusable KARSIFT autonomous-development platform. It is infrastructure for coordinating software-development work across KARSIFT product repositories. It is not a product-specific application repository.

## 2. Authority hierarchy

When instructions conflict, use this order:

1. Platform and provider safety restrictions.
2. Canonical repository governance and approved policy.
3. Accepted architecture and decision records.
4. The exact authorized ADP change package and version.
5. Repository-wide agent instructions.
6. Directory-specific instructions.
7. GitHub issue and pull-request instructions that do not conflict with higher authority.
8. Chat conversations and informal notes.

Chat memory is never the sole source of durable workflow truth.

## 3. Sources of truth

- Code and version-controlled platform artifacts: GitHub.
- Authorized change scope: the exact immutable ADP change-package version.
- Workflow state: the Control Plane database once implemented.
- Production reality: live deployment systems and telemetry.
- Founder decisions: auditable decision records bound to the affected object or version.

## 4. Branch model

- `main`: stable platform baseline.
- `develop`: integrated development state.
- Short-lived branches: bounded changes, normally `change/ADP-###-slug`.

Do not push implementation work directly to `main` or `develop` once the bootstrap foundation is established.

## 5. Change discipline

Meaningful work must be bounded by an ADP change package appropriate to its risk. Agents must:

- remain inside approved scope;
- respect explicit out-of-scope items;
- avoid unrelated refactoring;
- preserve existing protections;
- add or update relevant tests;
- record exact evidence and resulting revisions;
- report uncertainty honestly.

A material scope or authority change requires a new or revised authorized change version.

## 6. Separation of duties

The implementation worker must not be the final independent verifier of its own work. No agent or workflow may:

- approve its own implementation;
- waive mandatory checks;
- reduce its own verification requirements;
- expand its own permissions or spending authority;
- fabricate founder approval;
- weaken a protection and use the weakened rule to authorize the same change.

## 7. Current technical activation state

The repository is in bootstrap mode.

Disabled until separately implemented, tested, evidenced, and activated:

- autonomous AI worker dispatch;
- automatic merge;
- autonomous merge;
- preview or staging deployment;
- production deployment;
- autonomous production release;
- autonomous incident repair.

Governance permission and technical capability are separate states.

## 8. Safety principles

- Prefer deterministic software over AI where deterministic verification is reliable.
- Use least privilege and scoped machine identities.
- Keep production credentials away from implementation workers.
- Use idempotency and reconciliation for external side effects.
- Revalidate queued work for freshness and continuing authority before substantial AI execution.
- Preserve complete traceability from request to production outcome.
- Expand autonomy gradually and only after objective evidence proves the previous level reliable.
