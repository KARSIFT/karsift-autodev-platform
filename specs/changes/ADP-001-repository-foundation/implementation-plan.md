# ADP-001 Implementation Plan

## Technical approach

Use the empty repository bootstrap to establish durable governance and architecture artifacts before any application code or autonomous agent integration is introduced.

## Sequence

1. Bootstrap `main` with the repository identity.
2. Create `develop` as the integration branch.
3. Add repository-wide agent operating rules.
4. Add the product-independent platform charter.
5. Add the machine-readable ADP-001 change record.
6. Add specification and acceptance criteria.
7. Review ADP-001 in a pull request to `develop`.
8. After approval and merge, create the next bounded change for the executable A0 → A1 Control Plane foundation.

## Next implementation slice

The next change should implement the smallest durable Control Plane capable of recording and reporting:

```text
Project
→ Founder request
→ Change contract and immutable version
→ Task
→ Workflow state
→ Decision
→ Audit event
```

It should also expose a minimal authenticated status/request API and persistent kill-switch state, while performing no autonomous AI dispatch.

## Expected initial technical direction

The executable foundation should prefer:

- TypeScript and Node.js for the Control Plane service;
- PostgreSQL for durable workflow state;
- a lightweight internal API framework;
- ordinary TypeScript for safety-critical workflow transitions;
- migrations and deterministic tests from the beginning;
- container-friendly local execution;
- provider-neutral interfaces for later AI worker adapters.

Exact framework and dependency versions must be selected during the implementation change using current supported stable versions and recorded for reproducibility.

## Risk controls

- No automated write capability is activated by ADP-001.
- No production credentials are introduced.
- No AI worker is granted repository write authority.
- No automatic merge is enabled.
- The first executable Control Plane change must include deterministic tests and a clear local run path before later agent integration begins.

## Rollback

Because ADP-001 is repository documentation and governance foundation only, rollback consists of reverting the exact integration commit before any later change depends on it. Later dependent changes must not proceed against a reverted or superseded foundation.
