# ADP-007 Acceptance Criteria

## Policy

- [ ] Authorization risk level is derived from immutable Change Contract content, not from caller-supplied request metadata.
- [ ] Missing or malformed governance facts prevent authorization.
- [ ] R0–R2 system authorization is allowed when no founder/EHR condition applies.
- [ ] R3 system authorization is denied unless strengthened gates are explicitly satisfied.
- [ ] R4 system authorization is denied.
- [ ] Founder/EHR conditions require founder-authenticated authority.
- [ ] Founder-authenticated authority can authorize R4.

## Evidence and revocation

- [ ] Authorization decisions are append-only.
- [ ] Every decision binds exact contract ID, version ID, version number, and content hash.
- [ ] Every decision records policy version, risk level, policy facts, actor, reason, and timestamp.
- [ ] A denied lower-authority retry does not revoke prior authorization.
- [ ] Explicit revocation removes effective authorization.

## Execution safety

- [ ] Freshness validation requires effective append-only authorization evidence.
- [ ] Mutable `change_contracts.status = AUTHORIZED` alone cannot produce a VALID freshness result.
- [ ] PostgreSQL rejects creation of an execution attempt without effective exact-version authorization.
- [ ] Existing queue state-version freshness and duplicate-safe lease behavior continue to pass.

## HTTP and least privilege

- [ ] Internal and founder credentials can submit authorization decisions.
- [ ] Founder-interface credentials receive HTTP 403 without reaching the authorization store.
- [ ] Policy-denied authorization attempts are durably recorded and surfaced as HTTP 403.
- [ ] Authorization route does not expose any AI dispatch or release operation.

## Regression and activation

- [ ] TypeScript compilation succeeds.
- [ ] Deterministic Node tests succeed.
- [ ] Development Compose validation succeeds.
- [ ] Runtime container build succeeds.
- [ ] All four migrations apply and rerun idempotently.
- [ ] PostgreSQL foundation invariants succeed.
- [ ] Queue/lease lifecycle verification succeeds.
- [ ] Freshness/continuing-authority verification succeeds using governed authorization.
- [ ] Dedicated authorization policy lifecycle verification succeeds.
- [ ] All autonomous capability switches remain disabled.
- [ ] Activation level remains A1.
