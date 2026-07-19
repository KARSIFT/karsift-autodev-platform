# ADP-018 — Proposal Action Authorization and Bounded Turn Orchestration

## Objective

Convert one immutable ADP-017 proposal into at most one separately governed action without granting the proposal adapter direct command, filesystem, repository-publication, merge, or deployment authority.

## Authority model

The proposal is intent evidence, not execution authority. An orchestration decision must bind:

- builder invocation and immutable builder limits;
- proposal request, run, evidence, action, and hashes;
- exact repository workspace and current state version;
- Task Context Pack and relevant-path scope;
- effective capability state at authorization and materialization time;
- the existing policy or request record required by the destination subsystem.

No payload may bypass the destination subsystem's own validation or database gates.

## Action routing

### COMPLETE

Records terminal completion evidence. It creates no command, context, or mutation record.

### BLOCKED

Records terminal blocked evidence with a bounded reason. It creates no side effect.

### REQUEST_CONTEXT

Creates ADP-016 read-context requests only. Requested paths and limits are revalidated against the immutable proposal, Task Context Pack relevant paths, protected-path policy, workspace state, and read-context bounds.

### REQUEST_COMMANDS

Creates ADP-014 command plans only. Every proposed command must independently satisfy the active project command policy, exact executable/argument allowlist, environment allowlist, timeout/output limits, command budget, workspace state, and WRITE capability semantics.

### PROPOSE_MUTATIONS

Creates ADP-015 mutation plans only. Every operation must independently satisfy WRITE mode, effective AUTOMATED_WRITE, relevant-path scope, operation and byte bounds, UTF-8/path safety, and exact before-hash semantics.

## Turn model

Each successfully generated proposal consumes one turn from the immutable ADP-011 `maxTurns` limit. A later proposal request is eligible only when:

1. the prior proposal action is terminal;
2. every materialized destination record is terminal;
3. fresh immutable result evidence is bound to the action;
4. the turn budget is not exhausted;
5. the builder invocation, workspace, and capabilities remain authoritative.

At most one orchestration action may be active per builder invocation.

## Persistence model

The Control Plane will add:

- immutable proposal-action decision records;
- mutable bounded action-run state with guarded transitions;
- immutable action-result evidence;
- exact links to any materialized context, command, or mutation records;
- deterministic content and result hashes;
- project and platform observability.

## Security boundary

- Proposal content remains inert until this layer and the destination subsystem authorize it.
- No shell command or file operation is executed by the orchestration layer itself.
- No live external provider is connected.
- No remote Git or publication credential is introduced.
- Global autonomous capability switches remain disabled.
