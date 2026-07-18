# ADP-007 — Governed Change Contract Authorization and Policy/Risk Gate

## Problem

Before ADP-007, execution freshness depended in part on the mutable `change_contracts.status` field. A status value is useful lifecycle metadata, but it is insufficient as durable authorization evidence because it is not bound to an exact immutable Change Contract version, policy version, actor authority, or decision rationale.

## Required authority model

Execution authority must be represented by an append-only authorization decision bound to:

- project
- Change Contract
- exact Change Contract version ID and version number
- exact immutable content hash
- authorization policy version
- R0–R4 risk level
- deterministic governance facts
- decision and reason code
- required authority class
- authenticated actor type and identity
- timestamp and optional rationale

A `DENIED` attempt is evidence of a failed authorization attempt. It does not revoke an earlier valid authorization. Only a later explicit `REVOKED` control decision removes effective authorization for the same exact version.

## Governance facts

The Control Plane derives authorization inputs from the immutable Change Contract content at `content.governance`.

Required fields:

- `riskLevel`: `R0` through `R4`
- `founderApprovalRequired`: boolean
- `ehrRequired`: boolean
- `strengthenedGatesSatisfied`: boolean
- `protectedTechnicalWork`: boolean

Missing or malformed governance data makes the contract ineligible for governed authorization.

## Policy v1

Policy identifier: `karsift-contract-authorization-v1`.

- R0–R2 may be authorized by the Control Plane system or founder when no founder/EHR condition applies.
- R3 may be authorized by the system only when strengthened gates are explicitly satisfied and no founder/EHR condition applies.
- R3 may be authorized by the founder directly.
- R4 requires founder-authenticated authority.
- Any explicit founder-approval condition requires founder-authenticated authority.
- Any EHR condition requires founder-authenticated authority.
- System or founder authority may revoke execution authority as a fail-closed safety action.
- Founder-interface credentials may not authorize or revoke contracts.

## Effective authorization

For one exact immutable Change Contract version, effective authorization is determined by the most recent control decision among `AUTHORIZED` and `REVOKED` for the exact version ID and content hash.

`DENIED` records are intentionally excluded from the effective-control sequence so a lower-authority failed attempt cannot revoke previously granted authority.

## Freshness integration

Freshness validation must read effective authorization evidence from the append-only authorization table. A mutable `change_contracts.status = AUTHORIZED` value alone must never satisfy freshness.

A work item is not fresh for execution when:

- no effective authorization exists for its exact Change Contract version/hash;
- a later explicit revocation exists;
- the contract version is no longer current;
- the contract is terminal;
- any earlier freshness condition fails.

## Execution-attempt database gate

PostgreSQL must independently reject creation of an execution attempt unless the work item references the current non-terminal Change Contract version and that exact version/hash has effective authorization.

This database trigger is a defense-in-depth boundary. It prevents direct mutation of `change_contracts.status` from manufacturing execution authority even if an application query is bypassed or regresses.

## HTTP boundary

The authorization operation is:

`POST /v1/change-contracts/:contractId/authorization-decisions`

Body:

- `action`: `AUTHORIZE` or `REVOKE`
- `rationale`: optional string

The internal service credential and founder credential may call the route. The founder-interface credential is explicitly denied.

A policy-denied `AUTHORIZE` request records durable `DENIED` evidence and returns HTTP 403. A successful authorization or explicit revocation returns HTTP 201.

## Activation boundary

ADP-007 remains activation level A1. It grants no AI provider credential, autonomous dispatch, automated write, automatic merge, deployment, production release, or incident-repair capability.
