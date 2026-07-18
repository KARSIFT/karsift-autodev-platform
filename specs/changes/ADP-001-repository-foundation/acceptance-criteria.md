# ADP-001 Acceptance Criteria

## AC-01 — Canonical bootstrap rules exist

Given the automation platform repository
When an AI or human contributor begins work
Then repository-wide instructions define the authority hierarchy, sources of truth, branch discipline, separation of duties, and disabled capabilities.

## AC-02 — Platform is product-independent

Given the platform charter
When a future KARSIFT project is connected
Then the platform can manage it without embedding VocaNova-specific product rules into the shared platform core.

## AC-03 — Multi-project isolation is explicit

Given a managed project
When the Control Plane or a worker operates on it
Then repository access, policies, budgets, credentials, and environments are scoped to that project and do not imply access to other projects.

## AC-04 — Change packages are traceable

Given a meaningful platform change
When implementation begins
Then it has a stable `ADP-###` identity, bounded scope, explicit out-of-scope items, risk classification, and traceable branch/issue references.

## AC-05 — First Control Plane slice is defined

Given ADP-001 is approved
When the next implementation change is prepared
Then the minimum A0 → A1 Control Plane data and API responsibilities can be derived from canonical repository artifacts without relying on chat memory.

## AC-06 — No autonomous authority is activated

Given ADP-001 is merged
When repository state is inspected
Then autonomous worker dispatch, automatic merge, deployment, autonomous production release, and autonomous incident repair remain disabled.

## AC-07 — Bootstrap work uses a governed PR

Given the initial repository bootstrap is complete
When ADP-001 is proposed for integration
Then the change is presented in a pull request targeting `develop`, with the exact change branch and scope visible for founder review.
