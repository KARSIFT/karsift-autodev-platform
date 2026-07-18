CREATE TABLE IF NOT EXISTS workspace_command_policies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    policy_key text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    enabled boolean NOT NULL DEFAULT true,
    purposes jsonb NOT NULL,
    rules jsonb NOT NULL,
    environment_allowlist jsonb NOT NULL,
    max_timeout_ms integer NOT NULL CHECK (max_timeout_ms > 0),
    max_output_bytes integer NOT NULL CHECK (max_output_bytes > 0),
    max_commands_per_workspace integer NOT NULL CHECK (max_commands_per_workspace > 0),
    policy_content jsonb NOT NULL,
    policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(project_id, policy_key, version),
    CHECK (jsonb_typeof(purposes) = 'array'),
    CHECK (jsonb_typeof(rules) = 'array'),
    CHECK (jsonb_typeof(environment_allowlist) = 'array')
);

CREATE TABLE IF NOT EXISTS workspace_command_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    repository_workspace_id uuid NOT NULL,
    repository_workspace_plan_id uuid NOT NULL,
    workspace_command_policy_id uuid NOT NULL,
    policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
    workspace_state_version integer NOT NULL CHECK (workspace_state_version >= 0),
    workspace_path text NOT NULL,
    workspace_mode text NOT NULL CHECK (workspace_mode IN ('READ_ONLY', 'WRITE')),
    purpose text NOT NULL CHECK (purpose IN ('INSPECT', 'BUILD', 'TEST', 'FORMAT_CHECK')),
    executable text NOT NULL,
    arguments jsonb NOT NULL,
    timeout_ms integer NOT NULL CHECK (timeout_ms > 0),
    max_output_bytes integer NOT NULL CHECK (max_output_bytes > 0),
    environment jsonb NOT NULL,
    plan_content jsonb NOT NULL,
    plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(project_id, plan_hash),
    FOREIGN KEY(repository_workspace_id, project_id)
        REFERENCES repository_workspaces(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(repository_workspace_plan_id, project_id)
        REFERENCES repository_workspace_plans(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(workspace_command_policy_id, project_id)
        REFERENCES workspace_command_policies(id, project_id) ON DELETE RESTRICT,
    CHECK (jsonb_typeof(arguments) = 'array'),
    CHECK (jsonb_typeof(environment) = 'object')
);

CREATE TABLE IF NOT EXISTS workspace_command_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    workspace_command_plan_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'PREPARED'
        CHECK (status IN ('PREPARED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT')),
    state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(workspace_command_plan_id),
    FOREIGN KEY(workspace_command_plan_id, project_id)
        REFERENCES workspace_command_plans(id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS workspace_command_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    workspace_command_run_id uuid NOT NULL,
    exit_code integer,
    signal text,
    timed_out boolean NOT NULL,
    duration_ms integer NOT NULL CHECK (duration_ms >= 0),
    stdout_sha256 text NOT NULL CHECK (stdout_sha256 ~ '^[a-f0-9]{64}$'),
    stderr_sha256 text NOT NULL CHECK (stderr_sha256 ~ '^[a-f0-9]{64}$'),
    stdout_bytes bigint NOT NULL CHECK (stdout_bytes >= 0),
    stderr_bytes bigint NOT NULL CHECK (stderr_bytes >= 0),
    stdout_truncated boolean NOT NULL,
    stderr_truncated boolean NOT NULL,
    error_code text,
    result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(workspace_command_run_id),
    FOREIGN KEY(workspace_command_run_id, project_id)
        REFERENCES workspace_command_runs(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS workspace_command_policies_project_idx
    ON workspace_command_policies(project_id, policy_key, version DESC);
CREATE INDEX IF NOT EXISTS workspace_command_plans_workspace_idx
    ON workspace_command_plans(repository_workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_command_runs_project_status_idx
    ON workspace_command_runs(project_id, status, created_at DESC);

DROP TRIGGER IF EXISTS workspace_command_policies_immutable ON workspace_command_policies;
CREATE TRIGGER workspace_command_policies_immutable
BEFORE UPDATE OR DELETE ON workspace_command_policies
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

DROP TRIGGER IF EXISTS workspace_command_plans_immutable ON workspace_command_plans;
CREATE TRIGGER workspace_command_plans_immutable
BEFORE UPDATE OR DELETE ON workspace_command_plans
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

DROP TRIGGER IF EXISTS workspace_command_evidence_immutable ON workspace_command_evidence;
CREATE TRIGGER workspace_command_evidence_immutable
BEFORE UPDATE OR DELETE ON workspace_command_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

CREATE OR REPLACE FUNCTION enforce_workspace_command_plan_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    workspace_row record;
    workspace_plan_row record;
    policy_row record;
    command_count integer;
BEGIN
    SELECT workspace.*
      INTO workspace_row
      FROM repository_workspaces workspace
     WHERE workspace.id = NEW.repository_workspace_id
       AND workspace.project_id = NEW.project_id;

    IF workspace_row.id IS NULL
       OR workspace_row.status <> 'MATERIALIZED'
       OR workspace_row.workspace_path IS NULL
       OR workspace_row.workspace_path <> NEW.workspace_path
       OR workspace_row.state_version <> NEW.workspace_state_version THEN
        RAISE EXCEPTION 'Workspace command plan conflict: workspace is not the exact MATERIALIZED state';
    END IF;

    SELECT plan.*
      INTO workspace_plan_row
      FROM repository_workspace_plans plan
     WHERE plan.id = NEW.repository_workspace_plan_id
       AND plan.project_id = NEW.project_id
       AND plan.id = workspace_row.repository_workspace_plan_id;

    IF workspace_plan_row.id IS NULL OR workspace_plan_row.mode <> NEW.workspace_mode THEN
        RAISE EXCEPTION 'Workspace command plan conflict: workspace plan evidence does not match';
    END IF;

    SELECT policy.*
      INTO policy_row
      FROM workspace_command_policies policy
     WHERE policy.id = NEW.workspace_command_policy_id
       AND policy.project_id = NEW.project_id;

    IF policy_row.id IS NULL
       OR policy_row.enabled IS NOT TRUE
       OR policy_row.policy_hash <> NEW.policy_hash THEN
        RAISE EXCEPTION 'Workspace command plan conflict: policy is missing, disabled, or does not match';
    END IF;

    IF NOT (policy_row.purposes ? NEW.purpose) THEN
        RAISE EXCEPTION 'Workspace command plan conflict: purpose is not allowed by policy';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(policy_row.rules) AS rule
         WHERE rule->>'executable' = NEW.executable
           AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(rule->'allowedArguments') AS allowed_arguments
                WHERE allowed_arguments = NEW.arguments
           )
    ) THEN
        RAISE EXCEPTION 'Workspace command plan conflict: executable or arguments are not allowed by policy';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM jsonb_object_keys(NEW.environment) AS environment_key
         WHERE NOT (policy_row.environment_allowlist ? environment_key)
    ) THEN
        RAISE EXCEPTION 'Workspace command plan conflict: environment contains a key not allowed by policy';
    END IF;

    IF NEW.timeout_ms > policy_row.max_timeout_ms
       OR NEW.max_output_bytes > policy_row.max_output_bytes THEN
        RAISE EXCEPTION 'Workspace command plan conflict: execution limits exceed policy';
    END IF;

    SELECT count(*)
      INTO command_count
      FROM workspace_command_plans
     WHERE repository_workspace_id = NEW.repository_workspace_id
       AND project_id = NEW.project_id;

    IF command_count >= policy_row.max_commands_per_workspace THEN
        RAISE EXCEPTION 'Workspace command plan conflict: workspace command budget is exhausted';
    END IF;

    IF NEW.workspace_mode = 'WRITE'
       AND NOT is_effective_capability_enabled(NEW.project_id, 'AUTOMATED_WRITE') THEN
        RAISE EXCEPTION 'Workspace command plan conflict: AUTOMATED_WRITE capability is not enabled';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_command_plan_authority_gate ON workspace_command_plans;
CREATE TRIGGER workspace_command_plan_authority_gate
BEFORE INSERT ON workspace_command_plans
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_command_plan_authority();

CREATE OR REPLACE FUNCTION enforce_workspace_command_run_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    plan_row record;
    workspace_row record;
BEGIN
    IF NEW.state_version <> OLD.state_version + 1 THEN
        RAISE EXCEPTION 'Workspace command run conflict: state version must advance by one';
    END IF;

    IF OLD.status = 'PREPARED' AND NEW.status = 'RUNNING' THEN
        SELECT plan.*
          INTO plan_row
          FROM workspace_command_plans plan
         WHERE plan.id = OLD.workspace_command_plan_id
           AND plan.project_id = OLD.project_id;

        SELECT workspace.*
          INTO workspace_row
          FROM repository_workspaces workspace
         WHERE workspace.id = plan_row.repository_workspace_id
           AND workspace.project_id = OLD.project_id;

        IF plan_row.id IS NULL
           OR workspace_row.id IS NULL
           OR workspace_row.status <> 'MATERIALIZED'
           OR workspace_row.state_version <> plan_row.workspace_state_version
           OR workspace_row.workspace_path <> plan_row.workspace_path THEN
            RAISE EXCEPTION 'Workspace command run conflict: workspace authority is stale';
        END IF;

        IF plan_row.workspace_mode = 'WRITE'
           AND NOT is_effective_capability_enabled(OLD.project_id, 'AUTOMATED_WRITE') THEN
            RAISE EXCEPTION 'Workspace command run conflict: AUTOMATED_WRITE capability is not enabled';
        END IF;

        IF NEW.started_at IS NULL OR NEW.completed_at IS NOT NULL THEN
            RAISE EXCEPTION 'Workspace command run conflict: RUNNING timestamps are invalid';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'RUNNING'
       AND NEW.status IN ('SUCCEEDED', 'FAILED', 'TIMED_OUT') THEN
        IF NEW.started_at IS NULL OR NEW.completed_at IS NULL THEN
            RAISE EXCEPTION 'Workspace command run conflict: terminal timestamps are required';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Workspace command run conflict: invalid status transition';
END;
$$;

DROP TRIGGER IF EXISTS workspace_command_run_transition_gate ON workspace_command_runs;
CREATE TRIGGER workspace_command_run_transition_gate
BEFORE UPDATE ON workspace_command_runs
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_command_run_transition();

CREATE OR REPLACE FUNCTION enforce_workspace_command_evidence_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    run_row record;
BEGIN
    SELECT run.*
      INTO run_row
      FROM workspace_command_runs run
     WHERE run.id = NEW.workspace_command_run_id
       AND run.project_id = NEW.project_id;

    IF run_row.id IS NULL OR run_row.status <> 'RUNNING' THEN
        RAISE EXCEPTION 'Workspace command evidence conflict: run is not RUNNING';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_command_evidence_binding_gate ON workspace_command_evidence;
CREATE TRIGGER workspace_command_evidence_binding_gate
BEFORE INSERT ON workspace_command_evidence
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_command_evidence_binding();
