CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    name text NOT NULL,
    repository_full_name text NOT NULL UNIQUE,
    default_branch text NOT NULL DEFAULT 'main',
    integration_branch text NOT NULL DEFAULT 'develop',
    status text NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS founder_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    title text NOT NULL,
    body text NOT NULL,
    status text NOT NULL DEFAULT 'RECEIVED'
        CHECK (status IN ('RECEIVED', 'TRIAGED', 'PLANNED', 'COMPLETED', 'CANCELLED')),
    authority_context jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id)
);

CREATE INDEX IF NOT EXISTS founder_requests_project_created_idx
    ON founder_requests(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    request_id uuid,
    decision_type text NOT NULL,
    summary text NOT NULL,
    rationale text,
    authority_level text NOT NULL
        CHECK (authority_level IN ('R0', 'R1', 'R2', 'R3', 'R4')),
    decided_by text NOT NULL,
    decided_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    FOREIGN KEY(request_id, project_id)
        REFERENCES founder_requests(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS decisions_project_decided_idx
    ON decisions(project_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS change_contracts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    stable_id text NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'AUTHORIZED', 'SUPERSEDED', 'CANCELLED')),
    current_version integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(project_id, stable_id),
    UNIQUE(id, project_id)
);

CREATE TABLE IF NOT EXISTS change_contract_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id uuid NOT NULL,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    version integer NOT NULL CHECK (version > 0),
    content jsonb NOT NULL,
    content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(contract_id, version),
    UNIQUE(contract_id, content_hash),
    UNIQUE(id, project_id),
    FOREIGN KEY(contract_id, project_id)
        REFERENCES change_contracts(id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    change_contract_version_id uuid NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    status text NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'BLOCKED', 'READY', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    priority text NOT NULL DEFAULT 'P2'
        CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    FOREIGN KEY(change_contract_version_id, project_id)
        REFERENCES change_contract_versions(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS tasks_project_status_idx
    ON tasks(project_id, status, created_at);

CREATE TABLE IF NOT EXISTS workflow_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    task_id uuid,
    workflow_type text NOT NULL,
    status text NOT NULL DEFAULT 'CREATED'
        CHECK (status IN ('CREATED', 'RUNNING', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(task_id, project_id)
        REFERENCES tasks(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS workflow_runs_project_status_idx
    ON workflow_runs(project_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS capability_switches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_type text NOT NULL CHECK (scope_type IN ('GLOBAL', 'PROJECT')),
    project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
    capability text NOT NULL CHECK (
        capability IN (
            'AUTOMATED_WRITE',
            'AI_DISPATCH',
            'AUTO_MERGE',
            'DEPLOYMENT',
            'PRODUCTION_RELEASE',
            'INCIDENT_REPAIR'
        )
    ),
    enabled boolean NOT NULL DEFAULT false,
    reason text NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (scope_type = 'GLOBAL' AND project_id IS NULL)
        OR
        (scope_type = 'PROJECT' AND project_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS capability_switch_scope_unique_idx
    ON capability_switches (
        scope_type,
        COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
        capability
    );

CREATE TABLE IF NOT EXISTS audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
    actor_type text NOT NULL CHECK (actor_type IN ('FOUNDER', 'HUMAN', 'SYSTEM', 'AGENT')),
    actor_id text NOT NULL,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_project_occurred_idx
    ON audit_events(project_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION prevent_immutable_table_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS change_contract_versions_immutable ON change_contract_versions;
CREATE TRIGGER change_contract_versions_immutable
BEFORE UPDATE OR DELETE ON change_contract_versions
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

INSERT INTO capability_switches (
    scope_type,
    project_id,
    capability,
    enabled,
    reason,
    updated_by
)
VALUES
    ('GLOBAL', NULL, 'AUTOMATED_WRITE', false, 'A1 foundation: not activated', 'bootstrap'),
    ('GLOBAL', NULL, 'AI_DISPATCH', false, 'A1 foundation: not activated', 'bootstrap'),
    ('GLOBAL', NULL, 'AUTO_MERGE', false, 'A1 foundation: not activated', 'bootstrap'),
    ('GLOBAL', NULL, 'DEPLOYMENT', false, 'A1 foundation: not activated', 'bootstrap'),
    ('GLOBAL', NULL, 'PRODUCTION_RELEASE', false, 'A1 foundation: not activated', 'bootstrap'),
    ('GLOBAL', NULL, 'INCIDENT_REPAIR', false, 'A1 foundation: not activated', 'bootstrap')
ON CONFLICT DO NOTHING;
