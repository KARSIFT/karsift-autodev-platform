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
