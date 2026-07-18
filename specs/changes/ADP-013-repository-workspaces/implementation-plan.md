# ADP-013 Implementation Plan

1. Define canonical repository workspace plan hashing, deterministic workspace identity, and fail-closed path-scope rules.
2. Persist immutable workspace plans, bounded workspace lifecycle state, and immutable final diff evidence.
3. Bind plans to the exact builder invocation, execution attempt, Task Context Pack, repository identity, base SHA, and relevant paths.
4. Gate WRITE plan preparation and final evidence with independent `AUTOMATED_WRITE` capability checks.
5. Add a local-only Git workspace adapter constrained to configured source/workspace roots.
6. Materialize isolated clones at the exact locked base commit with no remote network or push behavior.
7. Collect normalized changed paths and per-path content hashes, including untracked files and symlinks without following links outside the workspace.
8. Enforce READ_ONLY and WRITE scope rules and record deterministic final evidence.
9. Clean up disposable workspaces only after evidence is durably recorded or when explicitly abandoned/failed.
10. Expose internal-only prepare/materialize/finalize/abandon/read/status operations.
11. Add Git and dedicated workspace directories to the runtime image.
12. Prove the lifecycle using a disposable local Git fixture and PostgreSQL while permanent global write/AI capabilities remain disabled.
13. Run the full exact-environment ten-migration CI chain and integrate only one fully validated head revision.
