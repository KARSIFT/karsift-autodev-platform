# ADP-009 Acceptance Criteria

## Execution evidence binding

- [ ] Every newly claimed execution attempt stores the exact pre-claim queue state version.
- [ ] Every newly claimed execution attempt stores the exact freshness validation ID used at claim time.
- [ ] Every newly claimed execution attempt stores the exact effective authorization decision ID used at claim time.
- [ ] Every newly claimed execution attempt stores the exact approved budget decision ID used at claim time.
- [ ] PostgreSQL rejects a new execution attempt without complete exact evidence references.
- [ ] PostgreSQL rejects evidence references that do not match the exact claim state.

## Task Context Pack

- [ ] At most one Task Context Pack exists per execution attempt.
- [ ] New pack creation requires a valid lease token and an active unexpired lease.
- [ ] Pack content never contains the lease token.
- [ ] Pack row is bound to the exact execution attempt, work item, task, Change Contract version/hash, authorization decision, freshness validation, and budget decision.
- [ ] Pack content includes project, contract, work, repository snapshot, evidence, and execution sections.
- [ ] Contract objective and execution-oriented sections are derived from immutable Change Contract content with deterministic fallbacks.
- [ ] Relevant repository paths are normalized, deduplicated, and sorted.
- [ ] Unsafe absolute or parent-traversal paths are rejected.
- [ ] Pack content hash is reproducible with the canonical stable-JSON SHA-256 function.
- [ ] Pack rows reject UPDATE and DELETE operations.

## Idempotency

- [ ] Repeating pack creation with the same lease proof and repository snapshot returns the same pack.
- [ ] Repeating pack creation with a different base branch, base SHA, or normalized path set is rejected.
- [ ] An identical retry may read back the existing pack after the execution attempt becomes terminal.
- [ ] A new pack cannot be created for an inactive or expired attempt.

## Least privilege and observability

- [ ] Only the internal Control Plane credential can create or read Task Context Packs through HTTP.
- [ ] Founder and founder-interface credentials are denied.
- [ ] Project status includes pack count and recent pack metadata.
- [ ] Platform status includes total pack count.

## Regression and activation

- [ ] Strict TypeScript compilation succeeds.
- [ ] Deterministic Node tests succeed.
- [ ] Development Compose validation succeeds.
- [ ] Runtime container build succeeds.
- [ ] All six migrations apply and rerun idempotently.
- [ ] PostgreSQL foundation invariants succeed.
- [ ] Queue/lease lifecycle succeeds with evidence-bound execution attempts.
- [ ] Freshness/authority lifecycle remains green.
- [ ] Governed authorization lifecycle remains green.
- [ ] AI Budget Governor lifecycle remains green.
- [ ] Dedicated execution-evidence and Task Context Pack lifecycle succeeds.
- [ ] All permanent global autonomous capability switches remain disabled.
- [ ] Activation level remains A1.
