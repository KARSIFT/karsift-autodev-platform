CREATE TABLE IF NOT EXISTS builder_session_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_invocation_id uuid NOT NULL,
    builder_invocation_plan_id uuid NOT NULL,
    execution_attempt_id uuid NOT NULL,
    task_context_pack_id uuid NOT NULL,
    task_context_pack_hash text NOT NULL CHECK (task_context_pack_hash ~ '^[a-f0-9]{64}$'),
    repository_workspace_id uuid NOT NULL,
    repository_workspace_plan_id uuid NOT NULL,
    initial_read_context_run_id uuid NOT NULL,
    max_turns integer NOT NULL CHECK (max_turns > 0),
    plan_content jsonb NOT NULL,
    plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(builder_invocation_id),
    FOREIGN KEY(builder_invocation_id, project_id)
        REFERENCES builder_invocations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(builder_invocation_plan_id, project_id)
        REFERENCES builder_invocation_plans(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(execution_attempt_id, project_id)
        REFERENCES execution_attempts(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(task_context_pack_id, project_id)
        REFERENCES task_context_packs(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(repository_workspace_id, project_id)
        REFERENCES repository_workspaces(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(repository_workspace_plan_id, project_id)
        REFERENCES repository_workspace_plans(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(initial_read_context_run_id, project_id)
        REFERENCES workspace_read_context_runs(id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS builder_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_session_plan_id uuid NOT NULL,
    builder_invocation_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'PREPARED'
        CHECK (status IN (
            'PREPARED', 'READY_FOR_TURN', 'WAITING_ACTION',
            'REFRESH_CONTEXT', 'WAITING_REFRESH_CONTEXT',
            'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'
        )),
    state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    current_read_context_run_id uuid NOT NULL,
    current_proposal_run_id uuid,
    current_action_run_id uuid,
    turn_count integer NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(builder_session_plan_id),
    UNIQUE(builder_invocation_id),
    FOREIGN KEY(builder_session_plan_id, project_id)
        REFERENCES builder_session_plans(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(builder_invocation_id, project_id)
        REFERENCES builder_invocations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(current_read_context_run_id, project_id)
        REFERENCES workspace_read_context_runs(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(current_proposal_run_id, project_id)
        REFERENCES builder_proposal_runs(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(current_action_run_id, project_id)
        REFERENCES builder_proposal_action_runs(id, project_id) ON DELETE RESTRICT,
    CHECK (
        (status IN ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED') AND completed_at IS NOT NULL)
        OR
        (status NOT IN ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED') AND completed_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS builder_sessions_project_status_idx
    ON builder_sessions(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS builder_session_step_claims (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_session_id uuid NOT NULL,
    claim_owner text NOT NULL CHECK (length(claim_owner) BETWEEN 1 AND 300),
    claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
    status text NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'COMPLETED', 'RELEASED', 'EXPIRED')),
    lease_expires_at timestamptz NOT NULL,
    operation text CHECK (operation IS NULL OR operation IN (
        'START_SESSION', 'PREPARE_PROPOSAL', 'GENERATE_PROPOSAL',
        'MATERIALIZE_ACTION', 'EXECUTE_CONTEXT_CAPTURE', 'EXECUTE_COMMAND',
        'EXECUTE_MUTATION', 'RECONCILE_ACTION', 'PREPARE_REFRESH_CONTEXT',
        'CAPTURE_REFRESH_CONTEXT', 'ADVANCE_AFTER_ACTION',
        'FINALIZE_COMPLETE', 'FINALIZE_BLOCKED', 'FAIL_STALE_AUTHORITY',
        'CANCEL_SESSION'
    )),
    started_state text NOT NULL,
    completed_state text,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    FOREIGN KEY(builder_session_id, project_id)
        REFERENCES builder_sessions(id, project_id) ON DELETE RESTRICT,
    CHECK (
        (status = 'ACTIVE' AND operation IS NULL AND completed_state IS NULL AND completed_at IS NULL)
        OR
        (status <> 'ACTIVE' AND completed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS builder_session_one_active_step_claim_idx
    ON builder_session_step_claims(builder_session_id)
    WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS builder_session_step_claim_expiry_idx
    ON builder_session_step_claims(status, lease_expires_at)
    WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS builder_session_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_session_id uuid NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED')),
    turn_count integer NOT NULL CHECK (turn_count >= 0),
    final_action_evidence_id uuid,
    final_action_evidence_hash text CHECK (
        final_action_evidence_hash IS NULL OR final_action_evidence_hash ~ '^[a-f0-9]{64}$'
    ),
    summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
    evidence_content jsonb NOT NULL,
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(builder_session_id),
    FOREIGN KEY(builder_session_id, project_id)
        REFERENCES builder_sessions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(final_action_evidence_id, project_id)
        REFERENCES builder_proposal_action_evidence(id, project_id) ON DELETE RESTRICT,
    CHECK (
        (outcome IN ('COMPLETED', 'BLOCKED')
         AND final_action_evidence_id IS NOT NULL
         AND final_action_evidence_hash ~ '^[a-f0-9]{64}$')
        OR
        (outcome IN ('FAILED', 'CANCELLED')
         AND final_action_evidence_id IS NULL
         AND final_action_evidence_hash IS NULL)
    )
);

DROP TRIGGER IF EXISTS builder_session_plans_immutable ON builder_session_plans;
CREATE TRIGGER builder_session_plans_immutable
BEFORE UPDATE OR DELETE ON builder_session_plans
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

DROP TRIGGER IF EXISTS builder_session_evidence_immutable ON builder_session_evidence;
CREATE TRIGGER builder_session_evidence_immutable
BEFORE UPDATE OR DELETE ON builder_session_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

CREATE OR REPLACE FUNCTION enforce_builder_session_plan_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    invocation_row record;
    plan_row record;
    attempt_row record;
    context_pack_row record;
    workspace_row record;
    workspace_plan_row record;
    read_context_row record;
BEGIN
    SELECT invocation.*
      INTO invocation_row
      FROM builder_invocations invocation
     WHERE invocation.id = NEW.builder_invocation_id
       AND invocation.project_id = NEW.project_id;

    SELECT plan.*
      INTO plan_row
      FROM builder_invocation_plans plan
     WHERE plan.id = NEW.builder_invocation_plan_id
       AND plan.project_id = NEW.project_id;

    SELECT attempt.*
      INTO attempt_row
      FROM execution_attempts attempt
     WHERE attempt.id = NEW.execution_attempt_id
       AND attempt.project_id = NEW.project_id;

    SELECT context_pack.*
      INTO context_pack_row
      FROM task_context_packs context_pack
     WHERE context_pack.id = NEW.task_context_pack_id
       AND context_pack.project_id = NEW.project_id;

    SELECT workspace.*
      INTO workspace_row
      FROM repository_workspaces workspace
     WHERE workspace.id = NEW.repository_workspace_id
       AND workspace.project_id = NEW.project_id;

    SELECT workspace_plan.*
      INTO workspace_plan_row
      FROM repository_workspace_plans workspace_plan
     WHERE workspace_plan.id = NEW.repository_workspace_plan_id
       AND workspace_plan.project_id = NEW.project_id;

    SELECT capture_run.*,
           capture_request.builder_invocation_id AS capture_builder_invocation_id,
           capture_request.repository_workspace_id AS capture_workspace_id,
           capture_request.task_context_pack_id AS capture_task_context_pack_id,
           capture_request.task_context_pack_hash AS capture_task_context_pack_hash
      INTO read_context_row
      FROM workspace_read_context_runs capture_run
      JOIN workspace_read_context_requests capture_request
        ON capture_request.id = capture_run.workspace_read_context_request_id
       AND capture_request.project_id = capture_run.project_id
     WHERE capture_run.id = NEW.initial_read_context_run_id
       AND capture_run.project_id = NEW.project_id;

    IF invocation_row.id IS NULL
       OR invocation_row.status <> 'PREPARED'
       OR invocation_row.builder_invocation_plan_id <> NEW.builder_invocation_plan_id
       OR invocation_row.execution_attempt_id <> NEW.execution_attempt_id
       OR plan_row.id IS NULL
       OR plan_row.plan_hash <> (NEW.plan_content->>'builderPlanHash')
       OR plan_row.execution_attempt_id <> NEW.execution_attempt_id
       OR plan_row.task_context_pack_id <> NEW.task_context_pack_id
       OR plan_row.task_context_pack_hash <> NEW.task_context_pack_hash
       OR plan_row.max_turns <> NEW.max_turns
       OR attempt_row.id IS NULL
       OR attempt_row.status <> 'ACTIVE'
       OR attempt_row.lease_expires_at <= now()
       OR context_pack_row.id IS NULL
       OR context_pack_row.execution_attempt_id <> NEW.execution_attempt_id
       OR context_pack_row.content_hash <> NEW.task_context_pack_hash
       OR workspace_row.id IS NULL
       OR workspace_row.status <> 'MATERIALIZED'
       OR workspace_row.repository_workspace_plan_id <> NEW.repository_workspace_plan_id
       OR workspace_plan_row.id IS NULL
       OR workspace_plan_row.builder_invocation_id <> NEW.builder_invocation_id
       OR workspace_plan_row.task_context_pack_id <> NEW.task_context_pack_id
       OR workspace_plan_row.task_context_pack_hash <> NEW.task_context_pack_hash
       OR read_context_row.id IS NULL
       OR read_context_row.status <> 'CAPTURED'
       OR read_context_row.capture_builder_invocation_id <> NEW.builder_invocation_id
       OR read_context_row.capture_workspace_id <> NEW.repository_workspace_id
       OR read_context_row.capture_task_context_pack_id <> NEW.task_context_pack_id
       OR read_context_row.capture_task_context_pack_hash <> NEW.task_context_pack_hash THEN
        RAISE EXCEPTION 'Builder session plan conflict: bound execution evidence is not active and exact';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_session_plan_authority_gate ON builder_session_plans;
CREATE TRIGGER builder_session_plan_authority_gate
BEFORE INSERT ON builder_session_plans
FOR EACH ROW EXECUTE FUNCTION enforce_builder_session_plan_authority();

CREATE OR REPLACE FUNCTION enforce_builder_session_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.state_version <> OLD.state_version + 1 THEN
        RAISE EXCEPTION 'Builder session conflict: state version must advance by one';
    END IF;

    IF NEW.builder_session_plan_id <> OLD.builder_session_plan_id
       OR NEW.project_id <> OLD.project_id
       OR NEW.builder_invocation_id <> OLD.builder_invocation_id THEN
        RAISE EXCEPTION 'Builder session conflict: immutable session binding cannot change';
    END IF;

    IF OLD.status IN ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED') THEN
        RAISE EXCEPTION 'Builder session conflict: terminal session cannot transition';
    END IF;

    IF OLD.status = 'PREPARED'
       AND NEW.status IN ('READY_FOR_TURN', 'FAILED', 'CANCELLED') THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'READY_FOR_TURN'
       AND NEW.status IN ('READY_FOR_TURN', 'WAITING_ACTION', 'FAILED', 'CANCELLED') THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'WAITING_ACTION'
       AND NEW.status IN (
           'WAITING_ACTION', 'READY_FOR_TURN', 'REFRESH_CONTEXT',
           'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'
       ) THEN
        IF NEW.status IN ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED')
           AND NOT EXISTS (
               SELECT 1
                 FROM builder_session_evidence evidence
                WHERE evidence.builder_session_id = OLD.id
                  AND evidence.project_id = OLD.project_id
                  AND evidence.outcome = NEW.status
           ) THEN
            RAISE EXCEPTION 'Builder session conflict: terminal evidence is required';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'REFRESH_CONTEXT'
       AND NEW.status IN ('WAITING_REFRESH_CONTEXT', 'FAILED', 'CANCELLED') THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'WAITING_REFRESH_CONTEXT'
       AND NEW.status IN ('WAITING_REFRESH_CONTEXT', 'READY_FOR_TURN', 'FAILED', 'CANCELLED') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Builder session conflict: invalid state transition';
END;
$$;

DROP TRIGGER IF EXISTS builder_session_transition_gate ON builder_sessions;
CREATE TRIGGER builder_session_transition_gate
BEFORE UPDATE ON builder_sessions
FOR EACH ROW EXECUTE FUNCTION enforce_builder_session_transition();

CREATE OR REPLACE FUNCTION enforce_builder_session_step_claim_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    session_row record;
    session_plan_row record;
    attempt_row record;
BEGIN
    SELECT session.*
      INTO session_row
      FROM builder_sessions session
     WHERE session.id = NEW.builder_session_id
       AND session.project_id = NEW.project_id;

    SELECT session_plan.*
      INTO session_plan_row
      FROM builder_session_plans session_plan
     WHERE session_plan.id = session_row.builder_session_plan_id
       AND session_plan.project_id = NEW.project_id;

    SELECT attempt.*
      INTO attempt_row
      FROM execution_attempts attempt
     WHERE attempt.id = session_plan_row.execution_attempt_id
       AND attempt.project_id = NEW.project_id;

    IF session_row.id IS NULL
       OR session_row.status IN ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED')
       OR session_plan_row.id IS NULL
       OR attempt_row.id IS NULL
       OR attempt_row.status <> 'ACTIVE'
       OR attempt_row.lease_expires_at <= now() THEN
        RAISE EXCEPTION 'Builder session step claim conflict: session execution authority is not active';
    END IF;

    IF NEW.started_state <> session_row.status THEN
        RAISE EXCEPTION 'Builder session step claim conflict: started state does not match current session';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_session_step_claim_authority_gate
    ON builder_session_step_claims;
CREATE TRIGGER builder_session_step_claim_authority_gate
BEFORE INSERT ON builder_session_step_claims
FOR EACH ROW EXECUTE FUNCTION enforce_builder_session_step_claim_authority();

CREATE OR REPLACE FUNCTION enforce_builder_session_step_claim_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status = 'ACTIVE'
       AND NEW.status IN ('COMPLETED', 'RELEASED', 'EXPIRED') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Builder session step claim conflict: invalid claim transition';
END;
$$;

DROP TRIGGER IF EXISTS builder_session_step_claim_transition_gate
    ON builder_session_step_claims;
CREATE TRIGGER builder_session_step_claim_transition_gate
BEFORE UPDATE OF status ON builder_session_step_claims
FOR EACH ROW EXECUTE FUNCTION enforce_builder_session_step_claim_transition();

CREATE OR REPLACE FUNCTION enforce_builder_session_evidence_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    session_row record;
    session_plan_row record;
    action_evidence_row record;
    action_run_row record;
    action_decision_row record;
BEGIN
    SELECT session.*
      INTO session_row
      FROM builder_sessions session
     WHERE session.id = NEW.builder_session_id
       AND session.project_id = NEW.project_id;

    SELECT session_plan.*
      INTO session_plan_row
      FROM builder_session_plans session_plan
     WHERE session_plan.id = session_row.builder_session_plan_id
       AND session_plan.project_id = NEW.project_id;

    IF session_row.id IS NULL
       OR session_plan_row.id IS NULL
       OR session_row.status IN ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED')
       OR NEW.turn_count <> session_row.turn_count THEN
        RAISE EXCEPTION 'Builder session evidence conflict: session is not terminalizable';
    END IF;

    IF NEW.outcome IN ('COMPLETED', 'BLOCKED') THEN
        SELECT evidence.*
          INTO action_evidence_row
          FROM builder_proposal_action_evidence evidence
         WHERE evidence.id = NEW.final_action_evidence_id
           AND evidence.project_id = NEW.project_id;

        SELECT action_run.*
          INTO action_run_row
          FROM builder_proposal_action_runs action_run
         WHERE action_run.id = action_evidence_row.builder_proposal_action_run_id
           AND action_run.project_id = NEW.project_id;

        SELECT decision.*
          INTO action_decision_row
          FROM builder_proposal_action_decisions decision
         WHERE decision.id = action_run_row.builder_proposal_action_decision_id
           AND decision.project_id = NEW.project_id;

        IF action_evidence_row.id IS NULL
           OR action_evidence_row.result_hash <> NEW.final_action_evidence_hash
           OR action_run_row.id IS NULL
           OR action_run_row.status <> 'SATISFIED'
           OR action_decision_row.id IS NULL
           OR action_decision_row.builder_invocation_id <> session_plan_row.builder_invocation_id
           OR (NEW.outcome = 'COMPLETED' AND action_decision_row.action <> 'COMPLETE')
           OR (NEW.outcome = 'BLOCKED' AND action_decision_row.action <> 'BLOCKED') THEN
            RAISE EXCEPTION 'Builder session evidence conflict: final action evidence does not match terminal outcome';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_session_evidence_binding_gate ON builder_session_evidence;
CREATE TRIGGER builder_session_evidence_binding_gate
BEFORE INSERT ON builder_session_evidence
FOR EACH ROW EXECUTE FUNCTION enforce_builder_session_evidence_binding();
