CREATE TABLE IF NOT EXISTS work_queue_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    task_id uuid NOT NULL,
    priority text NOT NULL DEFAULT 'P2'
        CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
    execution_policy text NOT NULL DEFAULT 'WHEN_AI_CAPACITY_AVAILABLE'
        CHECK (execution_policy IN ('IMMEDIATE', 'WHEN_AI_CAPACITY_AVAILABLE', 'SCHEDULED')),
    status text NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN (
            'QUEUED', 'ELIGIBLE', 'DISPATCHED', 'RUNNING', 'COMPLETED',
            'FAILED', 'CANCELLED', 'BLOCKED', 'SUPERSEDED'
        )),
    waiting_reason text NOT NULL DEFAULT 'NONE'
        CHECK (waiting_reason IN (
            'NONE', 'QUOTA', 'BUDGET', 'DEPENDENCY', 'FOUNDER_DECISION',
            'EXTERNAL_SYSTEM', 'PROVIDER_UNAVAILABLE', 'POLICY'
        )),
    scheduled_for timestamptz,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
    state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(task_id, project_id),
    UNIQUE(project_id, idempotency_key),
    FOREIGN KEY(task_id, project_id)
        REFERENCES tasks(id, project_id) ON DELETE RESTRICT,
    CHECK (execution_policy <> 'SCHEDULED' OR scheduled_for IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS work_queue_dispatch_idx
    ON work_queue_items(status, priority, scheduled_for, created_at);

CREATE INDEX IF NOT EXISTS work_queue_project_status_idx
    ON work_queue_items(project_id, status, created_at);

CREATE TABLE IF NOT EXISTS execution_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_queue_item_id uuid NOT NULL,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    idempotency_key text NOT NULL,
    lease_owner text NOT NULL CHECK (length(lease_owner) BETWEEN 1 AND 300),
    lease_token uuid NOT NULL DEFAULT gen_random_uuid(),
    status text NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'SUCCEEDED', 'FAILED', 'RELEASED', 'EXPIRED')),
    lease_expires_at timestamptz NOT NULL,
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    result jsonb NOT NULL DEFAULT '{}'::jsonb,
    error jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(work_queue_item_id, attempt_number),
    UNIQUE(id, project_id),
    FOREIGN KEY(work_queue_item_id, project_id)
        REFERENCES work_queue_items(id, project_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS execution_attempt_one_active_idx
    ON execution_attempts(work_queue_item_id)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS execution_attempt_lease_expiry_idx
    ON execution_attempts(status, lease_expires_at)
    WHERE status = 'ACTIVE';
