CREATE TABLE IF NOT EXISTS builder_invocation_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    execution_attempt_id uuid NOT NULL,
    task_context_pack_id uuid NOT NULL,
    task_context_pack_hash text NOT NULL CHECK (task_context_pack_hash ~ '^[a-f0-9]{64}$'),
    provider_dispatch_decision_id uuid NOT NULL,
    provider_key text NOT NULL,
    adapter_key text NOT NULL,
    side_effect_mode text NOT NULL CHECK (side_effect_mode IN ('NONE', 'REPOSITORY_WRITE')),
    max_turns integer NOT NULL CHECK (max_turns BETWEEN 1 AND 50),
    retry_budget integer NOT NULL CHECK (retry_budget BETWEEN 0 AND 10),
    command_budget integer NOT NULL CHECK (command_budget BETWEEN 0 AND 500),
    timeout_seconds integer NOT NULL CHECK (timeout_seconds BETWEEN 30 AND 7200),
    plan_content jsonb NOT NULL,
    plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(execution_attempt_id),
    FOREIGN KEY(execution_attempt_id, project_id)
        REFERENCES execution_attempts(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(task_context_pack_id, project_id)
        REFERENCES task_context_packs(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(provider_dispatch_decision_id, project_id)
        REFERENCES ai_provider_dispatch_decisions(id, project_id) ON DELETE RESTRICT,
    CHECK (adapter_key = 'dry-run' AND side_effect_mode = 'NONE')
);

CREATE TABLE IF NOT EXISTS builder_invocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_invocation_plan_id uuid NOT NULL,
    execution_attempt_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'PREPARED'
        CHECK (status IN ('PREPARED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(builder_invocation_plan_id),
    UNIQUE(execution_attempt_id),
    FOREIGN KEY(builder_invocation_plan_id, project_id)
        REFERENCES builder_invocation_plans(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(execution_attempt_id, project_id)
        REFERENCES execution_attempts(id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS builder_invocation_results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_invocation_id uuid NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('SUCCEEDED', 'FAILED')),
    turns_used integer NOT NULL CHECK (turns_used >= 0),
    commands_used integer NOT NULL CHECK (commands_used >= 0),
    duration_ms integer NOT NULL CHECK (duration_ms >= 0),
    summary text NOT NULL CHECK (length(summary) > 0),
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(builder_invocation_id),
    FOREIGN KEY(builder_invocation_id, project_id)
        REFERENCES builder_invocations(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS builder_invocations_project_status_idx
    ON builder_invocations(project_id, status, created_at DESC);

DROP TRIGGER IF EXISTS builder_invocation_plans_immutable ON builder_invocation_plans;
CREATE TRIGGER builder_invocation_plans_immutable
BEFORE UPDATE OR DELETE ON builder_invocation_plans
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

DROP TRIGGER IF EXISTS builder_invocation_results_immutable ON builder_invocation_results;
CREATE TRIGGER builder_invocation_results_immutable
BEFORE UPDATE OR DELETE ON builder_invocation_results
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

CREATE OR REPLACE FUNCTION enforce_builder_invocation_plan_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    attempt_row record;
    pack_row record;
    dispatch_row record;
BEGIN
    SELECT execution_attempt.*
      INTO attempt_row
      FROM execution_attempts execution_attempt
     WHERE execution_attempt.id = NEW.execution_attempt_id
       AND execution_attempt.project_id = NEW.project_id;

    IF attempt_row.id IS NULL
       OR attempt_row.status <> 'ACTIVE'
       OR attempt_row.lease_expires_at <= now() THEN
        RAISE EXCEPTION 'Builder plan conflict: execution attempt is not active';
    END IF;

    SELECT context_pack.*
      INTO pack_row
      FROM task_context_packs context_pack
     WHERE context_pack.id = NEW.task_context_pack_id
       AND context_pack.project_id = NEW.project_id
       AND context_pack.execution_attempt_id = NEW.execution_attempt_id;

    IF pack_row.id IS NULL OR pack_row.content_hash <> NEW.task_context_pack_hash THEN
        RAISE EXCEPTION 'Builder plan conflict: Task Context Pack evidence does not match';
    END IF;

    IF attempt_row.provider_dispatch_decision_id IS NULL
       OR attempt_row.provider_dispatch_decision_id <> NEW.provider_dispatch_decision_id
       OR pack_row.provider_dispatch_decision_id IS NULL
       OR pack_row.provider_dispatch_decision_id <> NEW.provider_dispatch_decision_id THEN
        RAISE EXCEPTION 'Builder plan conflict: provider dispatch evidence does not match';
    END IF;

    SELECT dispatch_decision.*
      INTO dispatch_row
      FROM ai_provider_dispatch_decisions dispatch_decision
     WHERE dispatch_decision.id = NEW.provider_dispatch_decision_id
       AND dispatch_decision.project_id = NEW.project_id;

    IF dispatch_row.id IS NULL
       OR dispatch_row.outcome <> 'READY'
       OR dispatch_row.waiting_reason <> 'NONE'
       OR dispatch_row.provider_key IS NULL
       OR dispatch_row.provider_key <> NEW.provider_key
       OR dispatch_row.capability <> 'CODE_BUILDER' THEN
        RAISE EXCEPTION 'Builder plan conflict: provider dispatch is not READY';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_invocation_plan_evidence_gate ON builder_invocation_plans;
CREATE TRIGGER builder_invocation_plan_evidence_gate
BEFORE INSERT ON builder_invocation_plans
FOR EACH ROW EXECUTE FUNCTION enforce_builder_invocation_plan_evidence();

CREATE OR REPLACE FUNCTION enforce_builder_invocation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.state_version <> OLD.state_version + 1 THEN
        RAISE EXCEPTION 'Builder invocation conflict: state version must advance by one';
    END IF;

    IF OLD.status = 'PREPARED' AND NEW.status IN ('RUNNING', 'CANCELLED') THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'RUNNING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Builder invocation conflict: invalid status transition';
END;
$$;

DROP TRIGGER IF EXISTS builder_invocation_transition_gate ON builder_invocations;
CREATE TRIGGER builder_invocation_transition_gate
BEFORE UPDATE ON builder_invocations
FOR EACH ROW EXECUTE FUNCTION enforce_builder_invocation_transition();

CREATE OR REPLACE FUNCTION enforce_builder_result_limits()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    invocation_row record;
    plan_row record;
BEGIN
    SELECT builder_invocation.*
      INTO invocation_row
      FROM builder_invocations builder_invocation
     WHERE builder_invocation.id = NEW.builder_invocation_id
       AND builder_invocation.project_id = NEW.project_id;

    IF invocation_row.id IS NULL OR invocation_row.status <> 'RUNNING' THEN
        RAISE EXCEPTION 'Builder result conflict: invocation is not running';
    END IF;

    SELECT invocation_plan.*
      INTO plan_row
      FROM builder_invocation_plans invocation_plan
     WHERE invocation_plan.id = invocation_row.builder_invocation_plan_id
       AND invocation_plan.project_id = NEW.project_id;

    IF NEW.turns_used > plan_row.max_turns
       OR NEW.commands_used > plan_row.command_budget
       OR NEW.duration_ms > plan_row.timeout_seconds * 1000 THEN
        RAISE EXCEPTION 'Builder result conflict: result exceeds execution limits';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_invocation_result_limit_gate ON builder_invocation_results;
CREATE TRIGGER builder_invocation_result_limit_gate
BEFORE INSERT ON builder_invocation_results
FOR EACH ROW EXECUTE FUNCTION enforce_builder_result_limits();
