# Acceptance Criteria

ADP-018 is complete only when all criteria below are proved by deterministic tests and a disposable PostgreSQL/local-workspace lifecycle.

1. One immutable proposal evidence record can produce at most one immutable orchestration decision.
2. The decision binds exact proposal request, run, evidence, action, proposal hash, builder invocation, workspace, state version, and Task Context Pack evidence.
3. `COMPLETE` and `BLOCKED` create terminal evidence and no destination subsystem records.
4. `REQUEST_CONTEXT` can create only ADP-016 requests and cannot bypass path, protected-file, symlink, byte, count, or workspace-state gates.
5. `REQUEST_COMMANDS` can create only ADP-014 plans and every command must pass the active exact command policy and resource bounds.
6. `PROPOSE_MUTATIONS` can create only ADP-015 plans and every mutation must pass WRITE mode, effective `AUTOMATED_WRITE`, relevant-path, before-hash, operation-count, and byte bounds.
7. A proposal payload cannot directly execute a command, read a file, or mutate a file.
8. At most one orchestration action is active per builder invocation.
9. A later proposal turn is rejected until the prior action and all materialized destination work are terminal with immutable result evidence.
10. The immutable builder `maxTurns` limit is enforced in TypeScript and PostgreSQL.
11. Concurrent identical authorization/materialization requests are idempotent and cannot duplicate destination work.
12. Proposal-action decisions and terminal evidence reject UPDATE and DELETE.
13. Internal credentials only may operate the orchestration API; founder and founder-interface credentials are denied.
14. Project and platform status surfaces expose action counts and states without secrets or proposal payload leakage.
15. All prior CI lifecycles remain green.
16. No live provider, remote Git, automatic merge, deployment, production release, or incident-repair capability is enabled.
