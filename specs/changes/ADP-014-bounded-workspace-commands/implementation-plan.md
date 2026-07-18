# Implementation Plan

1. Add deterministic workspace-command policy validation and immutable command-plan hashing.
2. Add a shell-free bounded local process runner with workspace-root, environment, timeout, and output controls.
3. Add PostgreSQL policy, plan, run, and terminal-evidence tables with immutable and transition triggers.
4. Add transactional policy creation, idempotent command preparation, atomic run claim, terminal evidence recording, and observability.
5. Add an internal-only HTTP and service boundary and wire it into the Control Plane runtime.
6. Add deterministic domain, runner, HTTP, and migration-contract tests.
7. Add a disposable PostgreSQL + local-Git lifecycle proving policy enforcement, duplicate safety, credential isolation, output bounds, timeout behavior, command budget, WRITE rechecks, immutable evidence, and clean workspace finalization.
8. Run the full canonical CI chain on the exact candidate head before integration.
