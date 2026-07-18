# ADP-008 Acceptance Criteria

## Budget policy and decisions

- [ ] Project budget policy stores monthly limit, per-work limit, maximum AI tier, enabled state, and updater identity.
- [ ] Monetary values use non-negative integer micro-USD.
- [ ] Deterministic work requires an explicit zero-cost APPROVED budget decision.
- [ ] AI work without a policy is denied.
- [ ] Disabled policies deny AI work.
- [ ] AI tiers above policy maximum are denied.
- [ ] Estimates above the per-work limit are denied.
- [ ] Work that would exceed the monthly limit is deferred with a budget-specific reason.
- [ ] Budget decisions are append-only and bound to the exact queue state version.

## Atomic reservations

- [ ] AI approvals atomically reserve the estimated maximum cost.
- [ ] Project policy row locking prevents concurrent monthly-budget overcommit.
- [ ] Only one live reservation exists for a work item.
- [ ] Queue state-version changes release stale uncommitted reservations.
- [ ] Current budget consumption distinguishes live reservations from settled actual cost.

## Lease and activation gates

- [ ] No work item can receive a lease without a current APPROVED budget decision.
- [ ] Deterministic approved work can receive a lease without an AI policy or reservation.
- [ ] AI-class work additionally requires a matching active reservation.
- [ ] AI-class work cannot receive a lease while `AI_DISPATCH` is disabled.
- [ ] PostgreSQL rejects direct execution-attempt insertion that bypasses budget or capability gates.
- [ ] Existing authorization and freshness gates continue to apply.

## Settlement

- [ ] AI lease creation commits its reservation to the exact execution attempt.
- [ ] AI attempts cannot complete successfully or fail terminally before reservation settlement.
- [ ] Actual settled cost cannot exceed the reserved maximum.
- [ ] Settled actual cost replaces reserved cost in current-period consumption.
- [ ] Released or expired attempts release committed reservations.

## HTTP and least privilege

- [ ] Founder or internal high-authority credentials can update project budget policy.
- [ ] Only the internal service credential can authorize work budget.
- [ ] Only the internal service credential can settle AI reservation cost.
- [ ] Founder-interface credential is denied from all budget execution-gate routes.

## Regression and activation

- [ ] Strict TypeScript compilation succeeds.
- [ ] Deterministic Node tests succeed.
- [ ] Development Compose validation succeeds.
- [ ] Runtime container build succeeds.
- [ ] All five migrations apply and rerun idempotently.
- [ ] PostgreSQL foundation invariants succeed.
- [ ] Queue/lease lifecycle succeeds with mandatory deterministic budget approval.
- [ ] Freshness/authority lifecycle succeeds with mandatory budget approval.
- [ ] Governed Change Contract authorization lifecycle remains green.
- [ ] Dedicated AI Budget Governor lifecycle succeeds.
- [ ] All global autonomous capability switches remain disabled.
- [ ] Activation level remains A1.
