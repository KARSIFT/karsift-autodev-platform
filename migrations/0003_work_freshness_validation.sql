CREATE TABLE IF NOT EXISTS work_validation_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_queue_item_id uuid NOT NULL,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    queue_state_version integer NOT NULL CHECK (queue_state_version >= 0),
    task_id uuid NOT NULL,
    change_contract_id uuid NOT NULL,
    change_contract_version_id uuid NOT NULL,
    change_contract_version integer NOT NULL CHECK (change_contract_version > 0),
    contract_content_hash text NOT NULL CHECK (contract_content_hash ~ '^[a-f0-9]{64}$'),
    outcome text NOT NULL CHECK (outcome IN ('VALID', 'BLOCKED', 'STALE', 'SUPERSEDED')),
    reason_code text NOT NULL CHECK (reason_code IN (
        'OK',
        'PROJECT_INACTIVE',
        'TASK_NOT_EXECUTABLE',
        'CONTRACT_NOT_AUTHORIZED',
        'CONTRACT_VERSION_STALE',
        'CONTRACT_TERMINATED'
    )),
    checks jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    FOREIGN KEY(work_queue_item_id, project_id)
        REFERENCES work_queue_items(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(task_id, project_id)
        REFERENCES tasks(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(change_contract_id, project_id)
        REFERENCES change_contracts(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(change_contract_version_id, project_id)
        REFERENCES change_contract_versions(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS work_validation_current_idx
    ON work_validation_runs(work_queue_item_id, queue_state_version, created_at DESC);

CREATE INDEX IF NOT EXISTS work_validation_project_outcome_idx
    ON work_validation_runs(project_id, outcome, created_at DESC);

DROP TRIGGER IF EXISTS work_validation_runs_immutable ON work_validation_runs;
CREATE TRIGGER work_validation_runs_immutable
BEFORE UPDATE OR DELETE ON work_validation_runs
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();
