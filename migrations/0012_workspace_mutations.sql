CREATE TABLE IF NOT EXISTS workspace_mutation_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    repository_workspace_id uuid NOT NULL,
    repository_workspace_plan_id uuid NOT NULL,
    builder_invocation_id uuid NOT NULL,
    workspace_state_version integer NOT NULL CHECK (workspace_state_version >= 0),
    workspace_path text NOT NULL,
    relevant_paths jsonb NOT NULL,
    operations jsonb NOT NULL,
    operation_count integer NOT NULL CHECK (operation_count > 0 AND operation_count <= 50),
    total_content_bytes integer NOT NULL CHECK (total_content_bytes >= 0 AND total_content_bytes <= 5000000),
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
    FOREIGN KEY(builder_invocation_id, project_id)
        REFERENCES builder_invocations(id, project_id) ON DELETE RESTRICT,
    CHECK (jsonb_typeof(relevant_paths) = 'array'),
    CHECK (jsonb_typeof(operations) = 'array')
);

CREATE TABLE IF NOT EXISTS workspace_mutation_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    repository_workspace_id uuid NOT NULL,
    workspace_mutation_plan_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'PREPARED'
        CHECK (status IN ('PREPARED', 'APPLYING', 'APPLIED', 'FAILED')),
    state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(workspace_mutation_plan_id),
    FOREIGN KEY(repository_workspace_id, project_id)
        REFERENCES repository_workspaces(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(workspace_mutation_plan_id, project_id)
        REFERENCES workspace_mutation_plans(id, project_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_mutation_one_applying_per_workspace_idx
    ON workspace_mutation_runs(project_id, repository_workspace_id)
    WHERE status = 'APPLYING';

CREATE TABLE IF NOT EXISTS workspace_mutation_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    workspace_mutation_run_id uuid NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('APPLIED', 'FAILED')),
    duration_ms integer NOT NULL CHECK (duration_ms >= 0),
    path_evidence jsonb NOT NULL,
    error_code text,
    result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(workspace_mutation_run_id),
    FOREIGN KEY(workspace_mutation_run_id, project_id)
        REFERENCES workspace_mutation_runs(id, project_id) ON DELETE RESTRICT,
    CHECK (jsonb_typeof(path_evidence) = 'array')
);

CREATE INDEX IF NOT EXISTS workspace_mutation_plans_workspace_idx
    ON workspace_mutation_plans(repository_workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_mutation_runs_project_status_idx
    ON workspace_mutation_runs(project_id, status, created_at DESC);

DROP TRIGGER IF EXISTS workspace_mutation_plans_immutable ON workspace_mutation_plans;
CREATE TRIGGER workspace_mutation_plans_immutable
BEFORE UPDATE OR DELETE ON workspace_mutation_plans
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

DROP TRIGGER IF EXISTS workspace_mutation_evidence_immutable ON workspace_mutation_evidence;
CREATE TRIGGER workspace_mutation_evidence_immutable
BEFORE UPDATE OR DELETE ON workspace_mutation_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

CREATE OR REPLACE FUNCTION enforce_workspace_mutation_plan_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    workspace_row record;
    workspace_plan_row record;
    operation_row jsonb;
    operation_path text;
    content_bytes integer;
    calculated_total_bytes integer := 0;
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
        RAISE EXCEPTION 'Workspace mutation plan conflict: workspace is not the exact MATERIALIZED state';
    END IF;

    SELECT plan.*
      INTO workspace_plan_row
      FROM repository_workspace_plans plan
     WHERE plan.id = NEW.repository_workspace_plan_id
       AND plan.project_id = NEW.project_id
       AND plan.id = workspace_row.repository_workspace_plan_id;

    IF workspace_plan_row.id IS NULL
       OR workspace_plan_row.mode <> 'WRITE'
       OR workspace_plan_row.builder_invocation_id <> NEW.builder_invocation_id THEN
        RAISE EXCEPTION 'Workspace mutation plan conflict: WRITE workspace plan evidence does not match';
    END IF;

    IF NEW.relevant_paths <> workspace_plan_row.relevant_paths THEN
        RAISE EXCEPTION 'Workspace mutation plan conflict: relevant-path evidence does not match';
    END IF;

    IF NOT is_effective_capability_enabled(NEW.project_id, 'AUTOMATED_WRITE') THEN
        RAISE EXCEPTION 'Workspace mutation plan conflict: AUTOMATED_WRITE capability is not enabled';
    END IF;

    IF NEW.operation_count <> jsonb_array_length(NEW.operations) THEN
        RAISE EXCEPTION 'Workspace mutation plan conflict: operation count does not match';
    END IF;

    IF (
        SELECT count(DISTINCT operation->>'path')
          FROM jsonb_array_elements(NEW.operations) AS operation
    ) <> NEW.operation_count THEN
        RAISE EXCEPTION 'Workspace mutation plan conflict: duplicate operation paths are not allowed';
    END IF;

    FOR operation_row IN SELECT * FROM jsonb_array_elements(NEW.operations)
    LOOP
        operation_path := operation_row->>'path';
        IF operation_path IS NULL OR operation_path = '' THEN
            RAISE EXCEPTION 'Workspace mutation plan conflict: operation path is required';
        END IF;

        IF NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(NEW.relevant_paths) AS allowed_path
             WHERE operation_path = allowed_path
                OR left(operation_path, length(allowed_path) + 1) = allowed_path || '/'
        ) THEN
            RAISE EXCEPTION 'Workspace mutation plan conflict: operation path is outside relevant scope';
        END IF;

        IF operation_row->>'type' = 'CREATE' THEN
            IF operation_row->'expectedBeforeHash' <> 'null'::jsonb
               OR operation_row->'content' = 'null'::jsonb THEN
                RAISE EXCEPTION 'Workspace mutation plan conflict: invalid CREATE operation';
            END IF;
        ELSIF operation_row->>'type' = 'UPDATE' THEN
            IF COALESCE(operation_row->>'expectedBeforeHash', '') !~ '^[a-f0-9]{64}$'
               OR operation_row->'content' = 'null'::jsonb THEN
                RAISE EXCEPTION 'Workspace mutation plan conflict: invalid UPDATE operation';
            END IF;
        ELSIF operation_row->>'type' = 'DELETE' THEN
            IF COALESCE(operation_row->>'expectedBeforeHash', '') !~ '^[a-f0-9]{64}$'
               OR operation_row->'content' <> 'null'::jsonb THEN
                RAISE EXCEPTION 'Workspace mutation plan conflict: invalid DELETE operation';
            END IF;
        ELSE
            RAISE EXCEPTION 'Workspace mutation plan conflict: unsupported operation type';
        END IF;

        IF operation_row->'content' <> 'null'::jsonb THEN
            content_bytes := octet_length(convert_to(operation_row->>'content', 'UTF8'));
            IF content_bytes > 1000000 THEN
                RAISE EXCEPTION 'Workspace mutation plan conflict: per-file content limit exceeded';
            END IF;
            calculated_total_bytes := calculated_total_bytes + content_bytes;
        END IF;
    END LOOP;

    IF calculated_total_bytes <> NEW.total_content_bytes
       OR calculated_total_bytes > 5000000 THEN
        RAISE EXCEPTION 'Workspace mutation plan conflict: total content byte count does not match';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_mutation_plan_authority_gate ON workspace_mutation_plans;
CREATE TRIGGER workspace_mutation_plan_authority_gate
BEFORE INSERT ON workspace_mutation_plans
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_mutation_plan_authority();

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

DROP TRIGGER IF EXISTS workspace_mutation_run_transition_gate ON workspace_mutation_runs;
CREATE TRIGGER workspace_mutation_run_transition_gate
BEFORE UPDATE ON workspace_mutation_runs
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_mutation_run_transition();

CREATE OR REPLACE FUNCTION enforce_workspace_mutation_evidence_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    run_row record;
BEGIN
    SELECT run.*
      INTO run_row
      FROM workspace_mutation_runs run
     WHERE run.id = NEW.workspace_mutation_run_id
       AND run.project_id = NEW.project_id;

    IF run_row.id IS NULL OR run_row.status <> 'APPLYING' THEN
        RAISE EXCEPTION 'Workspace mutation evidence conflict: run is not APPLYING';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_mutation_evidence_binding_gate ON workspace_mutation_evidence;
CREATE TRIGGER workspace_mutation_evidence_binding_gate
BEFORE INSERT ON workspace_mutation_evidence
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_mutation_evidence_binding();
