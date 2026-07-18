CREATE TABLE IF NOT EXISTS builder_proposal_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_invocation_id uuid NOT NULL,
    builder_invocation_plan_id uuid NOT NULL,
    execution_attempt_id uuid NOT NULL,
    task_context_pack_id uuid NOT NULL,
    task_context_pack_hash text NOT NULL CHECK (task_context_pack_hash ~ '^[a-f0-9]{64}$'),
    provider_dispatch_decision_id uuid NOT NULL,
    provider_key text NOT NULL,
    workspace_read_context_snapshot_id uuid NOT NULL,
    workspace_read_context_snapshot_hash text NOT NULL CHECK (workspace_read_context_snapshot_hash ~ '^[a-f0-9]{64}$'),
    relevant_paths jsonb NOT NULL,
    adapter_key text NOT NULL CHECK (adapter_key = 'fixture-proposal'),
    input_content jsonb NOT NULL,
    input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(project_id, input_hash),
    FOREIGN KEY(builder_invocation_id, project_id)
        REFERENCES builder_invocations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(builder_invocation_plan_id, project_id)
        REFERENCES builder_invocation_plans(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(execution_attempt_id, project_id)
        REFERENCES execution_attempts(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(task_context_pack_id, project_id)
        REFERENCES task_context_packs(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(provider_dispatch_decision_id, project_id)
        REFERENCES ai_provider_dispatch_decisions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(workspace_read_context_snapshot_id, project_id)
        REFERENCES workspace_read_context_snapshots(id, project_id) ON DELETE RESTRICT,
    CHECK (jsonb_typeof(relevant_paths) = 'array')
);

CREATE TABLE IF NOT EXISTS builder_proposal_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_proposal_request_id uuid NOT NULL,
    builder_invocation_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'PREPARED'
        CHECK (status IN ('PREPARED', 'GENERATING', 'GENERATED', 'FAILED')),
    state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    builder_dispatch_claim_id uuid,
    builder_dispatch_revalidation_id uuid,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(builder_proposal_request_id),
    FOREIGN KEY(builder_proposal_request_id, project_id)
        REFERENCES builder_proposal_requests(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(builder_invocation_id, project_id)
        REFERENCES builder_invocations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(builder_dispatch_claim_id, project_id)
        REFERENCES builder_dispatch_claims(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(builder_dispatch_revalidation_id, project_id)
        REFERENCES builder_dispatch_revalidations(id, project_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS builder_proposal_one_generating_per_invocation_idx
    ON builder_proposal_runs(project_id, builder_invocation_id)
    WHERE status = 'GENERATING';

CREATE TABLE IF NOT EXISTS builder_proposal_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_proposal_run_id uuid NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('GENERATED', 'FAILED')),
    proposal_action text CHECK (
      proposal_action IS NULL OR proposal_action IN (
        'COMPLETE', 'REQUEST_CONTEXT', 'REQUEST_COMMANDS', 'PROPOSE_MUTATIONS', 'BLOCKED'
      )
    ),
    proposal_content jsonb,
    proposal_hash text CHECK (proposal_hash IS NULL OR proposal_hash ~ '^[a-f0-9]{64}$'),
    external_provider_called boolean NOT NULL CHECK (external_provider_called = false),
    provider_request_id text CHECK (provider_request_id IS NULL),
    usage jsonb NOT NULL,
    error_code text,
    result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(builder_proposal_run_id),
    FOREIGN KEY(builder_proposal_run_id, project_id)
        REFERENCES builder_proposal_runs(id, project_id) ON DELETE RESTRICT,
    CHECK (
      (outcome = 'GENERATED' AND proposal_action IS NOT NULL AND proposal_content IS NOT NULL AND proposal_hash IS NOT NULL AND error_code IS NULL)
      OR
      (outcome = 'FAILED' AND proposal_action IS NULL AND proposal_content IS NULL AND proposal_hash IS NULL AND error_code IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS builder_proposal_requests_invocation_idx
    ON builder_proposal_requests(builder_invocation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS builder_proposal_runs_project_status_idx
    ON builder_proposal_runs(project_id, status, created_at DESC);

DROP TRIGGER IF EXISTS builder_proposal_requests_immutable ON builder_proposal_requests;
CREATE TRIGGER builder_proposal_requests_immutable
BEFORE UPDATE OR DELETE ON builder_proposal_requests
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

DROP TRIGGER IF EXISTS builder_proposal_evidence_immutable ON builder_proposal_evidence;
CREATE TRIGGER builder_proposal_evidence_immutable
BEFORE UPDATE OR DELETE ON builder_proposal_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

CREATE OR REPLACE FUNCTION enforce_builder_proposal_request_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    invocation_row record;
    plan_row record;
    snapshot_row record;
BEGIN
    SELECT invocation.*
      INTO invocation_row
      FROM builder_invocations invocation
     WHERE invocation.id = NEW.builder_invocation_id
       AND invocation.project_id = NEW.project_id;

    IF invocation_row.id IS NULL OR invocation_row.status <> 'PREPARED' THEN
        RAISE EXCEPTION 'Builder proposal request conflict: builder invocation is not PREPARED';
    END IF;

    SELECT plan.*
      INTO plan_row
      FROM builder_invocation_plans plan
     WHERE plan.id = NEW.builder_invocation_plan_id
       AND plan.project_id = NEW.project_id
       AND plan.id = invocation_row.builder_invocation_plan_id;

    IF plan_row.id IS NULL
       OR plan_row.execution_attempt_id <> NEW.execution_attempt_id
       OR plan_row.task_context_pack_id <> NEW.task_context_pack_id
       OR plan_row.task_context_pack_hash <> NEW.task_context_pack_hash
       OR plan_row.provider_dispatch_decision_id <> NEW.provider_dispatch_decision_id
       OR plan_row.provider_key <> NEW.provider_key THEN
        RAISE EXCEPTION 'Builder proposal request conflict: builder plan evidence does not match';
    END IF;

    SELECT snapshot.*
      INTO snapshot_row
      FROM workspace_read_context_snapshots snapshot
      JOIN workspace_read_context_runs capture_run
        ON capture_run.id = snapshot.workspace_read_context_run_id
       AND capture_run.project_id = snapshot.project_id
      JOIN workspace_read_context_requests capture_request
        ON capture_request.id = capture_run.workspace_read_context_request_id
       AND capture_request.project_id = capture_run.project_id
     WHERE snapshot.id = NEW.workspace_read_context_snapshot_id
       AND snapshot.project_id = NEW.project_id
       AND capture_run.status = 'CAPTURED';

    IF snapshot_row.id IS NULL
       OR snapshot_row.snapshot_hash <> NEW.workspace_read_context_snapshot_hash THEN
        RAISE EXCEPTION 'Builder proposal request conflict: source snapshot evidence does not match';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM workspace_read_context_snapshots snapshot
          JOIN workspace_read_context_runs capture_run
            ON capture_run.id = snapshot.workspace_read_context_run_id
           AND capture_run.project_id = snapshot.project_id
          JOIN workspace_read_context_requests capture_request
            ON capture_request.id = capture_run.workspace_read_context_request_id
           AND capture_request.project_id = capture_run.project_id
         WHERE snapshot.id = NEW.workspace_read_context_snapshot_id
           AND snapshot.project_id = NEW.project_id
           AND capture_request.builder_invocation_id = NEW.builder_invocation_id
           AND capture_request.task_context_pack_id = NEW.task_context_pack_id
           AND capture_request.task_context_pack_hash = NEW.task_context_pack_hash
           AND capture_request.relevant_paths = NEW.relevant_paths
    ) THEN
        RAISE EXCEPTION 'Builder proposal request conflict: source snapshot authority does not match builder evidence';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_proposal_request_authority_gate ON builder_proposal_requests;
CREATE TRIGGER builder_proposal_request_authority_gate
BEFORE INSERT ON builder_proposal_requests
FOR EACH ROW EXECUTE FUNCTION enforce_builder_proposal_request_authority();

CREATE OR REPLACE FUNCTION enforce_builder_proposal_run_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    request_row record;
    claim_row record;
    revalidation_row record;
    invocation_row record;
BEGIN
    IF NEW.state_version <> OLD.state_version + 1 THEN
        RAISE EXCEPTION 'Builder proposal run conflict: state version must advance by one';
    END IF;

    IF OLD.status = 'PREPARED' AND NEW.status = 'GENERATING' THEN
        IF NEW.builder_dispatch_claim_id IS NULL OR NEW.builder_dispatch_revalidation_id IS NULL THEN
            RAISE EXCEPTION 'Builder proposal run conflict: dispatch claim evidence is required';
        END IF;

        SELECT request.*
          INTO request_row
          FROM builder_proposal_requests request
         WHERE request.id = OLD.builder_proposal_request_id
           AND request.project_id = OLD.project_id;

        SELECT invocation.*
          INTO invocation_row
          FROM builder_invocations invocation
         WHERE invocation.id = OLD.builder_invocation_id
           AND invocation.project_id = OLD.project_id;

        SELECT claim.*
          INTO claim_row
          FROM builder_dispatch_claims claim
         WHERE claim.id = NEW.builder_dispatch_claim_id
           AND claim.project_id = OLD.project_id;

        SELECT revalidation.*
          INTO revalidation_row
          FROM builder_dispatch_revalidations revalidation
         WHERE revalidation.id = NEW.builder_dispatch_revalidation_id
           AND revalidation.project_id = OLD.project_id;

        IF request_row.id IS NULL
           OR invocation_row.id IS NULL
           OR invocation_row.status <> 'PREPARED'
           OR claim_row.id IS NULL
           OR claim_row.builder_invocation_id <> OLD.builder_invocation_id
           OR claim_row.status <> 'ACTIVE'
           OR claim_row.lease_expires_at <= now()
           OR claim_row.revalidation_id <> NEW.builder_dispatch_revalidation_id
           OR revalidation_row.id IS NULL
           OR revalidation_row.builder_dispatch_claim_id <> NEW.builder_dispatch_claim_id
           OR revalidation_row.outcome <> 'READY'
           OR revalidation_row.selected_provider_key <> request_row.provider_key THEN
            RAISE EXCEPTION 'Builder proposal run conflict: active READY dispatch evidence does not match';
        END IF;

        IF NEW.started_at IS NULL OR NEW.completed_at IS NOT NULL THEN
            RAISE EXCEPTION 'Builder proposal run conflict: GENERATING timestamps are invalid';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'GENERATING' AND NEW.status IN ('GENERATED', 'FAILED') THEN
        IF NEW.started_at IS NULL OR NEW.completed_at IS NULL THEN
            RAISE EXCEPTION 'Builder proposal run conflict: terminal timestamps are required';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Builder proposal run conflict: invalid status transition';
END;
$$;

DROP TRIGGER IF EXISTS builder_proposal_run_transition_gate ON builder_proposal_runs;
CREATE TRIGGER builder_proposal_run_transition_gate
BEFORE UPDATE ON builder_proposal_runs
FOR EACH ROW EXECUTE FUNCTION enforce_builder_proposal_run_transition();

CREATE OR REPLACE FUNCTION enforce_builder_proposal_evidence_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    run_row record;
BEGIN
    SELECT run.*
      INTO run_row
      FROM builder_proposal_runs run
     WHERE run.id = NEW.builder_proposal_run_id
       AND run.project_id = NEW.project_id;

    IF run_row.id IS NULL OR run_row.status <> 'GENERATING' THEN
        RAISE EXCEPTION 'Builder proposal evidence conflict: run is not GENERATING';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_proposal_evidence_binding_gate ON builder_proposal_evidence;
CREATE TRIGGER builder_proposal_evidence_binding_gate
BEFORE INSERT ON builder_proposal_evidence
FOR EACH ROW EXECUTE FUNCTION enforce_builder_proposal_evidence_binding();
