CREATE TABLE IF NOT EXISTS workspace_read_context_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    repository_workspace_id uuid NOT NULL,
    repository_workspace_plan_id uuid NOT NULL,
    builder_invocation_id uuid NOT NULL,
    task_context_pack_id uuid NOT NULL,
    task_context_pack_hash text NOT NULL CHECK (task_context_pack_hash ~ '^[a-f0-9]{64}$'),
    workspace_state_version integer NOT NULL CHECK (workspace_state_version >= 0),
    workspace_path text NOT NULL,
    relevant_paths jsonb NOT NULL,
    requested_paths jsonb NOT NULL,
    request_content jsonb NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(project_id, request_hash),
    FOREIGN KEY(repository_workspace_id, project_id)
        REFERENCES repository_workspaces(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(repository_workspace_plan_id, project_id)
        REFERENCES repository_workspace_plans(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(builder_invocation_id, project_id)
        REFERENCES builder_invocations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(task_context_pack_id, project_id)
        REFERENCES task_context_packs(id, project_id) ON DELETE RESTRICT,
    CHECK (jsonb_typeof(relevant_paths) = 'array'),
    CHECK (jsonb_typeof(requested_paths) = 'array')
);

CREATE TABLE IF NOT EXISTS workspace_read_context_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    repository_workspace_id uuid NOT NULL,
    workspace_read_context_request_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'PREPARED'
        CHECK (status IN ('PREPARED', 'CAPTURING', 'CAPTURED', 'FAILED')),
    state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(workspace_read_context_request_id),
    FOREIGN KEY(repository_workspace_id, project_id)
        REFERENCES repository_workspaces(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(workspace_read_context_request_id, project_id)
        REFERENCES workspace_read_context_requests(id, project_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_read_context_one_capture_per_workspace_idx
    ON workspace_read_context_runs(project_id, repository_workspace_id)
    WHERE status = 'CAPTURING';

CREATE TABLE IF NOT EXISTS workspace_read_context_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    workspace_read_context_run_id uuid NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    file_count integer NOT NULL CHECK (file_count > 0 AND file_count <= 200),
    total_bytes integer NOT NULL CHECK (total_bytes >= 0 AND total_bytes <= 2000000),
    files jsonb NOT NULL,
    snapshot_content jsonb NOT NULL,
    snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(workspace_read_context_run_id),
    FOREIGN KEY(workspace_read_context_run_id, project_id)
        REFERENCES workspace_read_context_runs(id, project_id) ON DELETE RESTRICT,
    CHECK (jsonb_typeof(files) = 'array')
);

CREATE INDEX IF NOT EXISTS workspace_read_context_requests_workspace_idx
    ON workspace_read_context_requests(repository_workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_read_context_runs_project_status_idx
    ON workspace_read_context_runs(project_id, status, created_at DESC);

DROP TRIGGER IF EXISTS workspace_read_context_requests_immutable
    ON workspace_read_context_requests;
CREATE TRIGGER workspace_read_context_requests_immutable
BEFORE UPDATE OR DELETE ON workspace_read_context_requests
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

DROP TRIGGER IF EXISTS workspace_read_context_snapshots_immutable
    ON workspace_read_context_snapshots;
CREATE TRIGGER workspace_read_context_snapshots_immutable
BEFORE UPDATE OR DELETE ON workspace_read_context_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

CREATE OR REPLACE FUNCTION enforce_workspace_read_context_request_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    workspace_row record;
    plan_row record;
    requested_path text;
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
        RAISE EXCEPTION 'Workspace read context request conflict: workspace is not the exact MATERIALIZED state';
    END IF;

    SELECT plan.*
      INTO plan_row
      FROM repository_workspace_plans plan
     WHERE plan.id = NEW.repository_workspace_plan_id
       AND plan.project_id = NEW.project_id
       AND plan.id = workspace_row.repository_workspace_plan_id;

    IF plan_row.id IS NULL
       OR plan_row.builder_invocation_id <> NEW.builder_invocation_id
       OR plan_row.task_context_pack_id <> NEW.task_context_pack_id
       OR plan_row.task_context_pack_hash <> NEW.task_context_pack_hash
       OR plan_row.relevant_paths <> NEW.relevant_paths THEN
        RAISE EXCEPTION 'Workspace read context request conflict: workspace evidence does not match';
    END IF;

    IF jsonb_array_length(NEW.requested_paths) = 0
       OR jsonb_array_length(NEW.requested_paths) > 50 THEN
        RAISE EXCEPTION 'Workspace read context request conflict: requested path count is invalid';
    END IF;

    IF (
        SELECT count(DISTINCT value)
          FROM jsonb_array_elements_text(NEW.requested_paths) AS requested(value)
    ) <> jsonb_array_length(NEW.requested_paths) THEN
        RAISE EXCEPTION 'Workspace read context request conflict: duplicate requested paths are not allowed';
    END IF;

    FOR requested_path IN SELECT * FROM jsonb_array_elements_text(NEW.requested_paths)
    LOOP
        IF NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(NEW.relevant_paths) AS allowed_path
             WHERE requested_path = allowed_path
                OR left(requested_path, length(allowed_path) + 1) = allowed_path || '/'
        ) THEN
            RAISE EXCEPTION 'Workspace read context request conflict: requested path is outside relevant scope';
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_read_context_request_authority_gate
    ON workspace_read_context_requests;
CREATE TRIGGER workspace_read_context_request_authority_gate
BEFORE INSERT ON workspace_read_context_requests
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_read_context_request_authority();

CREATE OR REPLACE FUNCTION enforce_workspace_read_context_run_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    request_row record;
    workspace_row record;
BEGIN
    IF NEW.state_version <> OLD.state_version + 1 THEN
        RAISE EXCEPTION 'Workspace read context run conflict: state version must advance by one';
    END IF;

    IF OLD.status = 'PREPARED' AND NEW.status = 'CAPTURING' THEN
        SELECT request.*
          INTO request_row
          FROM workspace_read_context_requests request
         WHERE request.id = OLD.workspace_read_context_request_id
           AND request.project_id = OLD.project_id;

        SELECT workspace.*
          INTO workspace_row
          FROM repository_workspaces workspace
         WHERE workspace.id = OLD.repository_workspace_id
           AND workspace.project_id = OLD.project_id;

        IF request_row.id IS NULL
           OR workspace_row.id IS NULL
           OR workspace_row.status <> 'MATERIALIZED'
           OR workspace_row.state_version <> request_row.workspace_state_version
           OR workspace_row.workspace_path <> request_row.workspace_path
           OR workspace_row.repository_workspace_plan_id <> request_row.repository_workspace_plan_id THEN
            RAISE EXCEPTION 'Workspace read context run conflict: workspace authority is stale';
        END IF;

        IF EXISTS (
            SELECT 1
              FROM workspace_command_runs command_run
              JOIN workspace_command_plans command_plan
                ON command_plan.id = command_run.workspace_command_plan_id
               AND command_plan.project_id = command_run.project_id
             WHERE command_run.project_id = OLD.project_id
               AND command_plan.repository_workspace_id = OLD.repository_workspace_id
               AND command_run.status = 'RUNNING'
        ) THEN
            RAISE EXCEPTION 'Workspace read context run conflict: workspace command is active';
        END IF;

        IF EXISTS (
            SELECT 1
              FROM workspace_mutation_runs mutation_run
             WHERE mutation_run.project_id = OLD.project_id
               AND mutation_run.repository_workspace_id = OLD.repository_workspace_id
               AND mutation_run.status = 'APPLYING'
        ) THEN
            RAISE EXCEPTION 'Workspace read context run conflict: workspace mutation is active';
        END IF;

        IF NEW.started_at IS NULL OR NEW.completed_at IS NOT NULL THEN
            RAISE EXCEPTION 'Workspace read context run conflict: CAPTURING timestamps are invalid';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'CAPTURING' AND NEW.status IN ('CAPTURED', 'FAILED') THEN
        IF NEW.started_at IS NULL OR NEW.completed_at IS NULL THEN
            RAISE EXCEPTION 'Workspace read context run conflict: terminal timestamps are required';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Workspace read context run conflict: invalid status transition';
END;
$$;

DROP TRIGGER IF EXISTS workspace_read_context_run_transition_gate
    ON workspace_read_context_runs;
CREATE TRIGGER workspace_read_context_run_transition_gate
BEFORE UPDATE ON workspace_read_context_runs
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_read_context_run_transition();

CREATE OR REPLACE FUNCTION enforce_workspace_read_context_snapshot_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    run_row record;
    request_row record;
BEGIN
    SELECT run.*
      INTO run_row
      FROM workspace_read_context_runs run
     WHERE run.id = NEW.workspace_read_context_run_id
       AND run.project_id = NEW.project_id;

    IF run_row.id IS NULL OR run_row.status <> 'CAPTURING' THEN
        RAISE EXCEPTION 'Workspace read context snapshot conflict: run is not CAPTURING';
    END IF;

    SELECT request.*
      INTO request_row
      FROM workspace_read_context_requests request
     WHERE request.id = run_row.workspace_read_context_request_id
       AND request.project_id = NEW.project_id;

    IF request_row.id IS NULL OR request_row.request_hash <> NEW.request_hash THEN
        RAISE EXCEPTION 'Workspace read context snapshot conflict: request evidence does not match';
    END IF;

    IF NEW.file_count <> jsonb_array_length(NEW.files) THEN
        RAISE EXCEPTION 'Workspace read context snapshot conflict: file count does not match';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_read_context_snapshot_binding_gate
    ON workspace_read_context_snapshots;
CREATE TRIGGER workspace_read_context_snapshot_binding_gate
BEFORE INSERT ON workspace_read_context_snapshots
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_read_context_snapshot_binding();

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

        IF EXISTS (
            SELECT 1
              FROM workspace_read_context_runs capture_run
             WHERE capture_run.project_id = OLD.project_id
               AND capture_run.repository_workspace_id = plan_row.repository_workspace_id
               AND capture_run.status = 'CAPTURING'
        ) THEN
            RAISE EXCEPTION 'Workspace command run conflict: workspace read context capture is active';
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

CREATE OR REPLACE FUNCTION enforce_workspace_mutation_run_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    plan_row record;
    workspace_row record;
BEGIN
    IF NEW.state_version <> OLD.state_version + 1 THEN
        RAISE EXCEPTION 'Workspace mutation run conflict: state version must advance by one';
    END IF;

    IF OLD.status = 'PREPARED' AND NEW.status = 'APPLYING' THEN
        SELECT plan.*
          INTO plan_row
          FROM workspace_mutation_plans plan
         WHERE plan.id = OLD.workspace_mutation_plan_id
           AND plan.project_id = OLD.project_id;

        SELECT workspace.*
          INTO workspace_row
          FROM repository_workspaces workspace
         WHERE workspace.id = OLD.repository_workspace_id
           AND workspace.project_id = OLD.project_id;

        IF plan_row.id IS NULL
           OR workspace_row.id IS NULL
           OR workspace_row.status <> 'MATERIALIZED'
           OR workspace_row.state_version <> plan_row.workspace_state_version
           OR workspace_row.workspace_path <> plan_row.workspace_path
           OR workspace_row.repository_workspace_plan_id <> plan_row.repository_workspace_plan_id THEN
            RAISE EXCEPTION 'Workspace mutation run conflict: workspace authority is stale';
        END IF;

        IF EXISTS (
            SELECT 1
              FROM workspace_read_context_runs capture_run
             WHERE capture_run.project_id = OLD.project_id
               AND capture_run.repository_workspace_id = OLD.repository_workspace_id
               AND capture_run.status = 'CAPTURING'
        ) THEN
            RAISE EXCEPTION 'Workspace mutation run conflict: workspace read context capture is active';
        END IF;

        IF NOT is_effective_capability_enabled(OLD.project_id, 'AUTOMATED_WRITE') THEN
            RAISE EXCEPTION 'Workspace mutation run conflict: AUTOMATED_WRITE capability is not enabled';
        END IF;

        IF NEW.started_at IS NULL OR NEW.completed_at IS NOT NULL THEN
            RAISE EXCEPTION 'Workspace mutation run conflict: APPLYING timestamps are invalid';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'APPLYING' AND NEW.status IN ('APPLIED', 'FAILED') THEN
        IF NEW.started_at IS NULL OR NEW.completed_at IS NULL THEN
            RAISE EXCEPTION 'Workspace mutation run conflict: terminal timestamps are required';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Workspace mutation run conflict: invalid status transition';
END;
$$;
