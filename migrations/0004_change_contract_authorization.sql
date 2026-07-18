CREATE TABLE IF NOT EXISTS change_contract_authorization_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    change_contract_id uuid NOT NULL,
    change_contract_version_id uuid NOT NULL,
    change_contract_version integer NOT NULL CHECK (change_contract_version > 0),
    contract_content_hash text NOT NULL CHECK (contract_content_hash ~ '^[a-f0-9]{64}$'),
    policy_version text NOT NULL,
    risk_level text NOT NULL CHECK (risk_level IN ('R0', 'R1', 'R2', 'R3', 'R4')),
    decision text NOT NULL CHECK (decision IN ('AUTHORIZED', 'DENIED', 'REVOKED')),
    reason_code text NOT NULL CHECK (reason_code IN (
        'AUTHORIZED_BY_POLICY',
        'FOUNDER_AUTHORITY_REQUIRED',
        'R3_STRENGTHENED_GATES_REQUIRED',
        'AUTHORIZATION_REVOKED'
    )),
    required_authority text NOT NULL CHECK (required_authority IN ('SYSTEM_OR_FOUNDER', 'FOUNDER')),
    policy_facts jsonb NOT NULL,
    rationale text,
    actor_type text NOT NULL CHECK (actor_type IN ('FOUNDER', 'SYSTEM')),
    actor_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    FOREIGN KEY(change_contract_id, project_id)
        REFERENCES change_contracts(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(change_contract_version_id, project_id)
        REFERENCES change_contract_versions(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS change_contract_authorization_effective_idx
    ON change_contract_authorization_decisions(
        change_contract_version_id,
        created_at DESC,
        id DESC
    );

CREATE INDEX IF NOT EXISTS change_contract_authorization_project_idx
    ON change_contract_authorization_decisions(project_id, created_at DESC);

DROP TRIGGER IF EXISTS change_contract_authorization_decisions_immutable
    ON change_contract_authorization_decisions;
CREATE TRIGGER change_contract_authorization_decisions_immutable
BEFORE UPDATE OR DELETE ON change_contract_authorization_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

CREATE OR REPLACE FUNCTION has_effective_change_contract_authorization(
    p_change_contract_version_id uuid,
    p_contract_content_hash text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE((
        SELECT auth_decision.decision = 'AUTHORIZED'
          FROM change_contract_authorization_decisions auth_decision
         WHERE auth_decision.change_contract_version_id = p_change_contract_version_id
           AND auth_decision.contract_content_hash = p_contract_content_hash
           AND auth_decision.decision IN ('AUTHORIZED', 'REVOKED')
         ORDER BY auth_decision.created_at DESC, auth_decision.id DESC
         LIMIT 1
    ), false);
$$;

CREATE OR REPLACE FUNCTION enforce_execution_attempt_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    authorized boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
          FROM work_queue_items work
          JOIN tasks task
            ON task.id = work.task_id
           AND task.project_id = work.project_id
          JOIN change_contract_versions version
            ON version.id = task.change_contract_version_id
           AND version.project_id = work.project_id
          JOIN change_contracts contract
            ON contract.id = version.contract_id
           AND contract.project_id = work.project_id
         WHERE work.id = NEW.work_queue_item_id
           AND work.project_id = NEW.project_id
           AND contract.status NOT IN ('SUPERSEDED', 'CANCELLED')
           AND version.version = contract.current_version
           AND has_effective_change_contract_authorization(
                 version.id,
                 version.content_hash
               )
    ) INTO authorized;

    IF NOT authorized THEN
        RAISE EXCEPTION 'Execution authority conflict: current Change Contract version is not effectively authorized';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_attempt_authorization_gate ON execution_attempts;
CREATE TRIGGER execution_attempt_authorization_gate
BEFORE INSERT ON execution_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_execution_attempt_authorization();
