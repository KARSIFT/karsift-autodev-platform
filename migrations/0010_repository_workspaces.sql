CREATE TABLE IF NOT EXISTS repository_workspace_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_invocation_id uuid NOT NULL,
    execution_attempt_id uuid NOT NULL,
    task_context_pack_id uuid NOT NULL,
    task_context_pack_hash text NOT NULL CHECK (task_context_pack_hash ~ '^[a-f0-9]{64}$'),
    repository_full_name text NOT NULL,
    base_branch text NOT NULL,
    base_commit_sha text NOT NULL CHECK (base_commit_sha ~ '^[a-f0-9]{40,64}$'),
    relevant_paths jsonb NOT NULL,
    mode text NOT NULL CHECK (mode IN ('READ_ONLY', 'WRITE')),
    adapter_key text NOT NULL CHECK (adapter_key = 'local-git'),
    workspace_key text NOT NULL UNIQUE,
    branch_name text NOT NULL,
    plan_content jsonb NOT NULL,
    plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(builder_invocation_id),
    FOREIGN KEY(builder_invocation_id, project_id)
        REFERENCES builder_invocations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(execution_attempt_id, project_id)
        REFERENCES execution_attempts(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(task_context_pack_id, project_id)
        REFERENCES task_context_packs(id, project_id) ON DELETE RESTRICT,
    CHECK (jsonb_typeof(relevant_paths) = 'array')
);

CREATE TABLE IF NOT EXISTS repository_workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    repository_workspace_plan_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'PREPARED'
        CHECK (status IN (
            'PREPARED', 'MATERIALIZED', 'FINALIZED', 'SCOPE_VIOLATION',
            'ABANDONED', 'FAILED'
        )),
    state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    workspace_path text,
    materialized_head_sha text CHECK (
        materialized_head_sha IS NULL OR materialized_head_sha ~ '^[a-f0-9]{40,64}$'
    ),
    materialized_at timestamptz,
    finalized_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(repository_workspace_plan_id),
    FOREIGN KEY(repository_workspace_plan_id, project_id)
        REFERENCES repository_workspace_plans(id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS repository_workspace_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    repository_workspace_id uuid NOT NULL,
    base_commit_sha text NOT NULL CHECK (base_commit_sha ~ '^[a-f0-9]{40,64}$'),
    head_commit_sha text NOT NULL CHECK (head_commit_sha ~ '^[a-f0-9]{40,64}$'),
    changed_paths jsonb NOT NULL,
    changes jsonb NOT NULL,
    scope_valid boolean NOT NULL,
    violations jsonb NOT NULL,
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(repository_workspace_id),
    FOREIGN KEY(repository_workspace_id, project_id)
        REFERENCES repository_workspaces(id, project_id) ON DELETE RESTRICT,
    CHECK (jsonb_typeof(changed_paths) = 'array'),
    CHECK (jsonb_typeof(changes) = 'array'),
    CHECK (jsonb_typeof(violations) = 'array')
);

CREATE INDEX IF NOT EXISTS repository_workspaces_project_status_idx
    ON repository_workspaces(project_id, status, created_at DESC);

DROP TRIGGER IF EXISTS repository_workspace_plans_immutable
    ON repository_workspace_plans;
CREATE TRIGGER repository_workspace_plans_immutable
BEFORE UPDATE OR DELETE ON repository_workspace_plans
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

DROP TRIGGER IF EXISTS repository_workspace_evidence_immutable
    ON repository_workspace_evidence;
CREATE TRIGGER repository_workspace_evidence_immutable
BEFORE UPDATE OR DELETE ON repository_workspace_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

CREATE OR REPLACE FUNCTION enforce_repository_workspace_plan_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    invocation_row record;
    invocation_plan_row record;
    context_pack_row record;
BEGIN
    SELECT invocation.*
      INTO invocation_row
      FROM builder_invocations invocation
     WHERE invocation.id = NEW.builder_invocation_id
       AND invocation.project_id = NEW.project_id;

    IF invocation_row.id IS NULL OR invocation_row.status <> 'PREPARED' THEN
        RAISE EXCEPTION 'Repository workspace plan conflict: builder invocation must be PREPARED';
    END IF;

    SELECT invocation_plan.*
      INTO invocation_plan_row
      FROM builder_invocation_plans invocation_plan
     WHERE invocation_plan.id = invocation_row.builder_invocation_plan_id
       AND invocation_plan.project_id = NEW.project_id;

    IF invocation_plan_row.id IS NULL
       OR invocation_plan_row.execution_attempt_id <> NEW.execution_attempt_id THEN
        RAISE EXCEPTION 'Repository workspace plan conflict: execution attempt does not match builder plan';
    END IF;

    SELECT context_pack.*
      INTO context_pack_row
      FROM task_context_packs context_pack
     WHERE context_pack.id = NEW.task_context_pack_id
       AND context_pack.project_id = NEW.project_id
       AND context_pack.execution_attempt_id = NEW.execution_attempt_id;

    IF context_pack_row.id IS NULL
       OR context_pack_row.content_hash <> NEW.task_context_pack_hash
       OR invocation_plan_row.task_context_pack_id <> NEW.task_context_pack_id
       OR invocation_plan_row.task_context_pack_hash <> NEW.task_context_pack_hash
       OR context_pack_row.repository_full_name <> NEW.repository_full_name
       OR context_pack_row.base_branch <> NEW.base_branch
       OR context_pack_row.base_commit_sha <> NEW.base_commit_sha
       OR context_pack_row.content #> '{repositorySnapshot,relevantPaths}' <> NEW.relevant_paths THEN
        RAISE EXCEPTION 'Repository workspace plan conflict: Task Context Pack repository evidence does not match';
    END IF;

    IF NEW.mode = 'WRITE'
       AND NOT is_effective_capability_enabled(NEW.project_id, 'AUTOMATED_WRITE') THEN
        RAISE EXCEPTION 'Repository workspace plan conflict: AUTOMATED_WRITE capability is not enabled';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS repository_workspace_plan_evidence_gate
    ON repository_workspace_plans;
CREATE TRIGGER repository_workspace_plan_evidence_gate
BEFORE INSERT ON repository_workspace_plans
FOR EACH ROW EXECUTE FUNCTION enforce_repository_workspace_plan_evidence();

CREATE OR REPLACE FUNCTION enforce_repository_workspace_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.state_version <> OLD.state_version + 1 THEN
        RAISE EXCEPTION 'Repository workspace conflict: state version must advance by one';
    END IF;

    IF OLD.status = 'PREPARED'
       AND NEW.status IN ('MATERIALIZED', 'ABANDONED', 'FAILED') THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'MATERIALIZED'
       AND NEW.status IN ('FINALIZED', 'SCOPE_VIOLATION', 'ABANDONED', 'FAILED') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Repository workspace conflict: invalid status transition';
END;
$$;

DROP TRIGGER IF EXISTS repository_workspace_transition_gate
    ON repository_workspaces;
CREATE TRIGGER repository_workspace_transition_gate
BEFORE UPDATE ON repository_workspaces
FOR EACH ROW EXECUTE FUNCTION enforce_repository_workspace_transition();

CREATE OR REPLACE FUNCTION enforce_repository_workspace_evidence_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    workspace_row record;
    plan_row record;
BEGIN
    SELECT workspace.*
      INTO workspace_row
      FROM repository_workspaces workspace
     WHERE workspace.id = NEW.repository_workspace_id
       AND workspace.project_id = NEW.project_id;

    IF workspace_row.id IS NULL OR workspace_row.status <> 'MATERIALIZED' THEN
        RAISE EXCEPTION 'Repository workspace evidence conflict: workspace is not MATERIALIZED';
    END IF;

    SELECT plan.*
      INTO plan_row
      FROM repository_workspace_plans plan
     WHERE plan.id = workspace_row.repository_workspace_plan_id
       AND plan.project_id = NEW.project_id;

    IF plan_row.id IS NULL
       OR plan_row.base_commit_sha <> NEW.base_commit_sha
       OR workspace_row.materialized_head_sha <> NEW.head_commit_sha THEN
        RAISE EXCEPTION 'Repository workspace evidence conflict: base or head evidence does not match';
    END IF;

    IF plan_row.mode = 'WRITE'
       AND NOT is_effective_capability_enabled(NEW.project_id, 'AUTOMATED_WRITE') THEN
        RAISE EXCEPTION 'Repository workspace evidence conflict: AUTOMATED_WRITE capability is no longer enabled';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS repository_workspace_evidence_binding_gate
    ON repository_workspace_evidence;
CREATE TRIGGER repository_workspace_evidence_binding_gate
BEFORE INSERT ON repository_workspace_evidence
FOR EACH ROW EXECUTE FUNCTION enforce_repository_workspace_evidence_binding();
