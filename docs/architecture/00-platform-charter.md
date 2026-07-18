---
id: ADP-DOC-00
title: KARSIFT Autodev Platform Charter
version: 0.1
status: proposed
owner: founder
---

# KARSIFT Autodev Platform Charter

## Purpose

The KARSIFT Autodev Platform is a reusable, company-owned system for coordinating governed autonomous software development across multiple KARSIFT product repositories.

The target founder experience is:

> The founder talks to one AI about a project; behind that interface, a governed software-development system plans, queues, builds, verifies, releases, monitors, and repairs work within explicit authority boundaries.

## Architectural boundary

The platform is separate from the applications it manages.

```text
Founder
  ↓
Founder AI interface
  ↓
KARSIFT Autodev Control Plane
  ↓
Project adapters and project knowledge
  ↓
Project repositories and engineering workflows
```

Each managed project keeps its own product truth, architecture, code, environments, and project-specific policies. The shared platform owns reusable workflow coordination, execution safety, evidence tracking, worker abstractions, and cross-project operating controls.

## Core principles

1. One normal founder-facing conversational interface.
2. Durable operational state is company-owned and must not depend on vendor chat memory.
3. GitHub remains authoritative for code and approved version-controlled artifacts.
4. Deterministic systems are preferred wherever they can verify facts reliably.
5. AI workers are replaceable implementations of functional roles.
6. Implementation and independent verification remain separate.
7. Meaningful work is bound to a versioned, immutable change contract.
8. Autonomous actions are constrained by policy, permissions, risk, evidence, and budget.
9. Execution must be idempotent and duplicate-safe.
10. Queued work is revalidated before expensive execution.
11. Founder involvement is managed by exception.
12. Autonomy is activated progressively and can be independently disabled.

## Initial shared platform modules

The target Control Plane will eventually provide:

- request and decision management;
- project registry and project adapters;
- canonical knowledge retrieval references;
- change-contract registry;
- durable work queue;
- freshness and authority validation;
- policy and risk evaluation;
- AI budget and capacity governance;
- execution leases and idempotency;
- focused task-context packages;
- builder and verifier adapters;
- deterministic evidence registry;
- verification and repair-loop management;
- release-readiness coordination;
- audit ledger;
- status reporting through the founder interface.

Production deployment and incident-repair capabilities are later activation levels, not bootstrap requirements.

## Project isolation

Every managed project must have a stable project identity and explicit boundaries for:

- repository access;
- canonical product and architecture documents;
- allowed worker permissions;
- secrets and credentials;
- environments;
- policies and budgets;
- release authority.

A worker operating for one project must not receive access to another project merely because both use the same Control Plane.

## Sources of truth

- Product and project architecture truth: each project's approved canonical repository artifacts.
- Platform architecture and policy truth: this repository.
- Change truth: the exact authorized immutable change-contract version.
- Code truth: the relevant GitHub repository.
- Workflow truth: the Control Plane database once implemented.
- Evidence truth: original evidence systems with immutable references recorded by the Control Plane.
- Production truth: live production systems and telemetry.

## Initial activation sequence

```text
A0 — Observe and record
A1 — Coordinate requests, change contracts, decisions, and durable queueing
A2 — Autonomous bounded implementation with safe execution claiming
A3 — Independent verification and bounded repair
A4 — Policy-based automatic merge to develop
A5 — Automatic preview and staging
A6+ — Production autonomy only after separate evidence and activation
```

The first implementation goal is A0 → A1. No higher activation level is implied merely because related code exists.
