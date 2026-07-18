ALTER TABLE execution_attempts
    ADD COLUMN IF NOT EXISTS claim_queue_state_version integer CHECK (claim_queue_state_version >= 0),
    ADD COLUMN IF NOT EXISTS work_validation_run_id uuid,
    ADD COLUMN IF NOT EXISTS change_contract_authorization_decision_id uuid,
    ADD COLUMN IF NOT EXISTS ai_budget_decision_id uuid;

ALTER TABLE execution_attempts
    ADD CONSTRAINT execution_attempt_validation_evidence_fk
        FOREIGN KEY(work_validation_run_id, project_id)
        REFERENCES work_validation_runs(id, project_id) ON DELETE RESTRICT,
    ADD CONSTRAINT execution_attempt_authorization_evidence_fk
        FOREIGN KEY(change_contract_authorization_decision_id, project_id)
        REFERENCES change_contract_authorization_decisions(id, project_id) ON DELETE RESTRICT,
    ADD CONSTRAINT execution_attempt_budget_evidence_fk
        FOREIGN KEY(ai_budget_decision_id, project_id)
        REFERENCES ai_budget_decisions(id, project_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS execution_attempt_evidence_idx
    ON execution_attempts(
        project_id,
        work_queue_item_id,
        claim_queue_state_version,
        created_at DESC
    );

CREATE OR REPLACE FUNCTION enforce_execution_attempt_evidence_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected_validation_id uuid;
    expected_authorization_id uuid;
    expected_budget_id uuid;
BEGIN
    IF NEW.claim_queue_state_version IS NULL
       OR NEW.work_validation_run_id IS NULL
       OR NEW.change_contract_authorization_decision_id IS NULL
       OR NEW.ai_budget_decision_id IS NULL THEN
        RAISE EXCEPTION 'Execution evidence conflict: exact claim evidence references are required';
    END IF;

    SELECT validation.id
      INTO expected_validation_id
      FROM work_queue_items work_item
      JOIN tasks task
        ON task.id = work_item.task_id
       AND task.project_id = work_item.project_id
      JOIN change_contract_versions contract_version
        ON contract_version.id = task.change_contract_version_id
       AND contract_version.project_id = work_item.project_id
      JOIN work_validation_runs validation
        ON validation.work_queue_item_id = work_item.id
       AND validation.project_id = work_item.project_id
       AND validation.queue_state_version = NEW.claim_queue_state_version
       AND validation.change_contract_version_id = contract_version.id
       AND validation.contract_content_hash = contract_version.content_hash
       AND validation.outcome = 'VALID'
     WHERE work_item.id = NEW.work_queue_item_id
       AND work_item.project_id = NEW.project_id
       AND work_item.state_version = NEW.claim_queue_state_version
     ORDER BY validation.created_at DESC, validation.id DESC
     LIMIT 1;

    IF expected_validation_id IS NULL OR expected_validation_id <> NEW.work_validation_run_id THEN
        RAISE EXCEPTION 'Execution evidence conflict: freshness validation does not match the exact claim state';
    END IF;

    SELECT auth_decision.id
      INTO expected_authorization_id
      FROM work_queue_items work_item
      JOIN tasks task
        ON task.id = work_item.task_id
       AND task.project_id = work_item.project_id
      JOIN change_contract_versions contract_version
        ON contract_version.id = task.change_contract_version_id
       AND contract_version.project_id = work_item.project_id
      JOIN change_contract_authorization_decisions auth_decision
        ON auth_decision.change_contract_version_id = contract_version.id
       AND auth_decision.project_id = work_item.project_id
       AND auth_decision.contract_content_hash = contract_version.content_hash
       AND auth_decision.decision IN ('AUTHORIZED', 'REVOKED')
     WHERE work_item.id = NEW.work_queue_item_id
       AND work_item.project_id = NEW.project_id
     ORDER BY auth_decision.created_at DESC, auth_decision.id DESC
     LIMIT 1;

    IF expected_authorization_id IS NULL
       OR expected_authorization_id <> NEW.change_contract_authorization_decision_id THEN
        RAISE EXCEPTION 'Execution evidence conflict: authorization decision is not the effective exact-version decision';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM change_contract_authorization_decisions
         WHERE id = expected_authorization_id
           AND project_id = NEW.project_id
           AND decision = 'AUTHORIZED'
    ) THEN
        RAISE EXCEPTION 'Execution evidence conflict: effective authorization is not AUTHORIZED';
    END IF;

    SELECT budget_decision.id
      INTO expected_budget_id
      FROM ai_budget_decisions budget_decision
     WHERE budget_decision.work_queue_item_id = NEW.work_queue_item_id
       AND budget_decision.project_id = NEW.project_id
       AND budget_decision.queue_state_version = NEW.claim_queue_state_version
     ORDER BY budget_decision.created_at DESC, budget_decision.id DESC
     LIMIT 1;

    IF expected_budget_id IS NULL OR expected_budget_id <> NEW.ai_budget_decision_id THEN
        RAISE EXCEPTION 'Execution evidence conflict: budget decision is not the current exact-state decision';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM ai_budget_decisions
         WHERE id = expected_budget_id
           AND project_id = NEW.project_id
           AND decision = 'APPROVED'
    ) THEN
        RAISE EXCEPTION 'Execution evidence conflict: exact-state budget decision is not APPROVED';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_attempt_evidence_binding_gate ON execution_attempts;
CREATE TRIGGER execution_attempt_evidence_binding_gate
BEFORE INSERT ON execution_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_execution_attempt_evidence_binding();

CREATE TABLE IF NOT EXISTS task_context_packs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    execution_attempt_id uuid NOT NULL,
    work_queue_item_id uuid NOT NULL,
    task_id uuid NOT NULL,
    claim_queue_state_version integer NOT NULL CHECK (claim_queue_state_version >= 0),
    work_validation_run_id uuid NOT NULL,
    change_contract_authorization_decision_id uuid NOT NULL,
    ai_budget_decision_id uuid NOT NULL,
    change_contract_id uuid NOT NULL,
    change_contract_version_id uuid NOT NULL,
    change_contract_version integer NOT NULL CHECK (change_contract_version > 0),
    contract_content_hash text NOT NULL CHECK (contract_content_hash ~ '^[a-f0-9]{64}$'),
    repository_full_name text NOT NULL,
    base_branch text NOT NULL,
    base_commit_sha text NOT NULL CHECK (base_commit_sha ~ '^[a-f0-9]{40,64}$'),
    content jsonb NOT NULL,
    content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(execution_attempt_id),
    UNIQUE(id, project_id),
    FOREIGN KEY(execution_attempt_id, project_id)
        REFERENCES execution_attempts(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(work_queue_item_id, project_id)
        REFERENCES work_queue_items(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(task_id, project_id)
        REFERENCES tasks(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(work_validation_run_id, project_id)
        REFERENCES work_validation_runs(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(change_contract_authorization_decision_id, project_id)
        REFERENCES change_contract_authorization_decisions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(ai_budget_decision_id, project_id)
        REFERENCES ai_budget_decisions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(change_contract_id, project_id)
        REFERENCES change_contracts(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(change_contract_version_id, project_id)
        REFERENCES change_contract_versions(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS task_context_packs_project_idx
    ON task_context_packs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS task_context_packs_contract_idx
    ON task_context_packs(change_contract_version_id, created_at DESC);

DROP TRIGGER IF EXISTS task_context_packs_immutable ON task_context_packs;
CREATE TRIGGER task_context_packs_immutable
BEFORE UPDATE OR DELETE ON task_context_packs
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();
