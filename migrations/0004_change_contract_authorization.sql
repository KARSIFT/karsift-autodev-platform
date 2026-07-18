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
