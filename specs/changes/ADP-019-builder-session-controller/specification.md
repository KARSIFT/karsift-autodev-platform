# ADP-019 — Durable Builder Session and Stepwise Turn Controller

## Objective

Introduce a durable, bounded controller that coordinates one builder invocation across proposal turns and already-governed action subsystems without creating an unbounded autonomous loop or bypassing any existing authority boundary.

## Core model

Each builder invocation may have at most one durable builder session. A session is bound to:

- one project
- one execution attempt
- one immutable builder invocation plan and plan hash
- one Task Context Pack and content hash
- one repository workspace
- the immutable `maxTurns` limit from the builder plan

The session stores workflow state only. It does not store provider credentials, shell strings, repository credentials, or mutable model prompts.

## Session states

- `PREPARED` — session exists but has not started advancing
- `READY_FOR_TURN` — prior evidence permits a proposal turn
- `WAITING_ACTION` — a generated proposal has an ADP-018 action that is not yet satisfied
- `COMPLETED` — a COMPLETE action produced immutable terminal evidence
- `BLOCKED` — a BLOCKED action produced immutable terminal evidence
- `FAILED` — deterministic session failure has been recorded
- `CANCELLED` — the session was explicitly cancelled

Terminal states have no outgoing transitions.

## Stepwise advancement

One controller step request may perform at most one bounded operation:

1. create or reuse the next proposal request when the session is `READY_FOR_TURN`;
2. generate that proposal through the existing ADP-017 proposal service when dispatch authority is available;
3. materialize the exact proposal action through ADP-018;
4. execute or capture one already-materialized child operation through its existing governed service;
5. reconcile ADP-018 action evidence after child work is terminal;
6. transition the session to the next state after exact immutable evidence is present.

A single step may not recursively call itself or drain an arbitrary queue of work.

## Authority preservation

The controller must never:

- execute command content directly;
- mutate files directly;
- read repository files directly;
- construct a mutation outside ADP-015;
- construct a command outside ADP-014;
- construct a read-context capture outside ADP-016;
- create proposal evidence outside ADP-017;
- create action evidence outside ADP-018;
- bypass AI budget, provider readiness, execution lease, workspace, capability, or Change Contract authority.

## Execution lease

A non-terminal session requires the bound execution attempt to remain active and unexpired. The controller may heartbeat the existing execution lease only through a dedicated Control Plane store operation that proves the exact lease token or a future durable controller lease credential. ADP-019 must not expose the execution lease token through HTTP responses, audit payloads, or session evidence.

If the execution attempt loses authority, the session fails closed and does not continue proposal generation or child execution.

## Turn progression

The authoritative turn count is the number of immutable proposal requests for the bound builder invocation.

A new proposal turn is eligible only when:

- the builder plan's `maxTurns` has not been exhausted;
- no proposal-action run is active;
- the exact previous action evidence is SATISFIED and is bound into the next ADP-017 request;
- the execution attempt remains active;
- any required provider dispatch gate remains valid.

ADP-019 does not weaken ADP-012 dispatch ownership. Concurrent step requests must not cause duplicate external adapter calls.

## Child action execution

For a `WAITING_ACTION` session:

- `REQUEST_CONTEXT`: a step may invoke one ADP-016 capture run that was materialized by ADP-018.
- `REQUEST_COMMANDS`: a step may invoke one PREPARED ADP-014 command run in ordinal order.
- `PROPOSE_MUTATIONS`: a step may invoke the one ADP-015 mutation run, subject to its own start-time capability and state checks.
- `COMPLETE` and `BLOCKED`: no child execution occurs; ADP-018 terminal evidence is consumed directly.

The controller chooses only among child records already bound into immutable ADP-018 materialization evidence.

## Concurrency

A session step uses a short-lived durable claim with:

- one active claim per builder session;
- owner and opaque claim token;
- bounded lease duration;
- expiry recovery;
- atomic state-version checks;
- append-only claim/recovery audit evidence.

A newly acquired claim owner may perform at most one controller operation before completing or releasing the claim.

## Completion evidence

Terminal session evidence is append-only and includes only immutable identifiers/hashes and bounded summaries:

- builder invocation and plan hash
- execution attempt
- Task Context Pack hash
- repository workspace
- turn count
- final proposal/action evidence IDs and hashes
- terminal outcome

No provider secret, lease token, source file content, command output body, or mutable repository credential may be stored in terminal session evidence.

## Activation boundary

ADP-019 remains at A1. The fixture proposal adapter remains the only proposal adapter. No live external provider, remote Git publication, automatic merge, deployment, production release, or incident repair is activated.
