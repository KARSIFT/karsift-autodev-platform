# Acceptance Criteria

ADP-014 is complete only when the exact PR head proves all of the following:

- Command policies, plans, and terminal evidence are immutable.
- Commands bind to one exact `MATERIALIZED` repository workspace state and path.
- WRITE command preparation and start both fail when `AUTOMATED_WRITE` is not effective.
- Unapproved executables, argument vectors, environment keys, timeouts, output limits, and excess command count fail closed.
- Process execution uses `shell: false` and the exact isolated workspace as working directory.
- Provider credentials are not inherited by executed commands.
- Concurrent run requests execute one prepared command at most once.
- Timeout, exit, signal, duration, output-byte, truncation, and SHA-256 evidence is durable.
- A bounded-output command records full byte counts while retaining only bounded in-memory capture.
- Command execution cannot escape the configured workspace root.
- Founder and founder-interface credentials cannot operate the workspace command API.
- The runtime image builds and all eleven migrations apply idempotently.
- All prior Control Plane lifecycle verifiers still pass.
- The dedicated disposable PostgreSQL + local-Git command lifecycle passes.
- Global autonomous capability switches remain disabled.
- No live AI provider, remote Git, commit, push, pull request, merge, deployment, or production capability is activated.
