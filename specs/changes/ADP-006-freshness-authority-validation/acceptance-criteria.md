# ADP-006 Acceptance Criteria

## AC-01 — Unauthorized work cannot execute

Given a queued task whose Change Contract is not authorized,
when validation runs,
then the item is blocked with reason `CONTRACT_NOT_AUTHORIZED` and no lease can be claimed.

## AC-02 — Valid current work becomes eligible

Given an active project, executable task, authorized Change Contract, and current exact version,
when validation runs,
then the validation outcome is `VALID` and the work item becomes `ELIGIBLE`.

## AC-03 — Validation is bound to queue state

Given valid work that has been validated,
when a lease is released or an expired lease is recovered,
then the queue state version changes and the previous validation cannot authorize another claim.

## AC-04 — Revalidation restores retry authority

Given retryable work with invalidated prior validation,
when deterministic validation succeeds again,
then a new lease may be claimed.

## AC-05 — New contract versions make old work stale

Given work tied to an older immutable Change Contract version,
when a newer version becomes current,
then validation returns `STALE`, blocks the queue item, and no lease can be claimed.

## AC-06 — Authority revocation after validation blocks claim

Given a current `VALID` validation,
when the Change Contract is cancelled or loses authorization before claim,
then the claim query returns no lease even before another validation run occurs.

## AC-07 — Terminal work is superseded

Given a cancelled/superseded Change Contract or terminal task,
when validation runs,
then the validation outcome is `SUPERSEDED` and the queue item becomes `SUPERSEDED`.

## AC-08 — Evidence is append-only

Given a work validation record,
when an update or delete is attempted at the database layer,
then the database rejects the mutation.

## AC-09 — Founder interface remains least privilege

Given the founder-interface credential,
when it attempts the internal validation route,
then the server returns `403`.

## AC-10 — Exact PostgreSQL verification passes

Given the exact candidate revision,
when CI runs,
then the real database verification proves unauthorized blocking, valid authorization, state-version invalidation, retry revalidation, stale version handling, post-validation revocation blocking, supersession, and append-only evidence.

## AC-11 — No autonomy is activated

Given ADP-006 is integrated,
when capability state is inspected,
then AI dispatch and all higher autonomous capabilities remain disabled.
