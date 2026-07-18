# Development Repository Workspace Roots

ADP-013 adds a local-only repository workspace adapter.

Default container paths:

- repository sources: `/var/lib/karsift/repositories`
- disposable workspaces: `/var/lib/karsift/workspaces`

Optional environment overrides:

- `REPOSITORY_SOURCE_ROOT`
- `REPOSITORY_WORKSPACE_ROOT`

The two roots must be different.

The Control Plane does not download repositories in ADP-013. A repository source must already exist beneath the source root and is addressed by a normalized relative path. The local adapter clones from that source into a deterministic child of the workspace root.

The source root should be mounted read-only when practical. The workspace root is disposable and writable by the Control Plane runtime user.

No GitHub App, SSH key, personal access token, remote clone, fetch, or push is configured by ADP-013. Remote repository materialization is a separate governed capability.
