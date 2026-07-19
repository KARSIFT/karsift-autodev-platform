# ADP-019 Acceptance Criteria

1. Each builder invocation has at most one durable builder session.
2. A session is bound to the exact builder plan, execution attempt, Task Context Pack, repository workspace, and immutable `maxTurns` limit.
3. Session state transitions are versioned, bounded, and enforced by PostgreSQL.
4. Terminal session states have no outgoing transitions.
5. Concurrent step requests may create at most one active step claim and only the claim owner may advance the session.
6. One step request performs at most one bounded operation; no recursive or unbounded draining loop exists.
7. Proposal generation occurs only through ADP-017 and preserves ADP-012 dispatch ownership/revalidation.
8. Proposal action materialization occurs only through ADP-018.
9. Context capture occurs only by invoking an ADP-016 run already materialized by ADP-018.
10. Command execution occurs only by invoking one ADP-014 command run already materialized by ADP-018.
11. Mutation application occurs only by invoking the ADP-015 mutation run already materialized by ADP-018.
12. The controller never interprets raw proposal payloads as direct shell, read, or write authority.
13. A later proposal turn requires exact SATISFIED previous action evidence and an unexhausted immutable turn budget.
14. An active session fails closed when its execution attempt is no longer active or its lease authority is stale.
15. Execution lease tokens and controller claim tokens are never returned in ordinary session/status responses or stored in immutable terminal evidence.
16. COMPLETE and BLOCKED outcomes produce immutable terminal session evidence without child execution.
17. Session completion evidence is append-only and deterministically hashed.
18. Identical concurrent prepare/step requests are duplicate-safe.
19. Founder and founder-interface credentials cannot operate builder sessions; internal Control Plane authority is required.
20. Project/platform status endpoints expose bounded counts/state metadata without proposal payloads, source content, command output bodies, or secrets.
21. All prior canonical CI lifecycles remain green.
22. The dedicated ADP-019 lifecycle proves step claims, one-operation advancement, child-subsystem routing, turn progression, terminal evidence, stale-authority failure, idempotency, and cleanup.
23. Global autonomous capability switches remain disabled.
24. No live external provider, remote Git publication, automatic merge, deployment, production release, or incident repair is activated.
