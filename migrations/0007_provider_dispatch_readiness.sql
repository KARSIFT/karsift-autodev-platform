CREATE TABLE IF NOT EXISTS ai_provider_capacity_observations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    provider_key text NOT NULL CHECK (provider_key ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
    capability text NOT NULL CHECK (capability IN ('CODE_BUILDER', 'CODE_REVIEWER')),
    status text NOT NULL CHECK (status IN (
        'HEALTHY', 'DEGRADED', 'QUOTA_EXHAUSTED', 'UNAVAILABLE'
    )),
    quota_reset_at timestamptz,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    observed_by text NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    UNIQUE(id, project_id),
    CHECK (expires_at > observed_at)
);

CREATE INDEX IF NOT EXISTS ai_provider_capacity_lookup_idx
    ON ai_provider_capacity_observations(
        project_id,
        provider_key,
        capability,
        observed_at DESC,
        id DESC
    );

CREATE TABLE IF NOT EXISTS ai_provider_dispatch_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    work_queue_item_id uuid NOT NULL,
    queue_state_version integer NOT NULL CHECK (queue_state_version >= 0),
    ai_budget_decision_id uuid NOT NULL,
    provider_key text NOT NULL CHECK (provider_key ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
    capability text NOT NULL CHECK (capability IN ('CODE_BUILDER', 'CODE_REVIEWER')),
    capacity_observation_id uuid,
    outcome text NOT NULL CHECK (outcome IN ('READY', 'WAIT')),
    waiting_reason text NOT NULL CHECK (waiting_reason IN (
        'NONE', 'QUOTA', 'PROVIDER_UNAVAILABLE'
    )),
    reason_code text NOT NULL CHECK (reason_code IN (
        'PROVIDER_READY',
        'PROVIDER_OBSERVATION_MISSING',
        'PROVIDER_OBSERVATION_STALE',
        'PROVIDER_QUOTA_EXHAUSTED',
        'PROVIDER_DEGRADED',
        'PROVIDER_UNAVAILABLE'
    )),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    FOREIGN KEY(work_queue_item_id, project_id)
        REFERENCES work_queue_items(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(ai_budget_decision_id, project_id)
        REFERENCES ai_budget_decisions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(capacity_observation_id, project_id)
        REFERENCES ai_provider_capacity_observations(id, project_id) ON DELETE RESTRICT,
    CHECK (
        (outcome = 'READY' AND waiting_reason = 'NONE' AND capacity_observation_id IS NOT NULL)
        OR outcome = 'WAIT'
    )
);

CREATE INDEX IF NOT EXISTS ai_provider_dispatch_work_state_idx
    ON ai_provider_dispatch_decisions(
        work_queue_item_id,
        queue_state_version,
        created_at DESC,
        id DESC
    );
CREATE INDEX IF NOT EXISTS ai_provider_dispatch_project_idx
    ON ai_provider_dispatch_decisions(project_id, created_at DESC);

DROP TRIGGER IF EXISTS ai_provider_capacity_observations_immutable
    ON ai_provider_capacity_observations;
CREATE TRIGGER ai_provider_capacity_observations_immutable
BEFORE UPDATE OR DELETE ON ai_provider_capacity_observations
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

DROP TRIGGER IF EXISTS ai_provider_dispatch_decisions_immutable
    ON ai_provider_dispatch_decisions;
CREATE TRIGGER ai_provider_dispatch_decisions_immutable
BEFORE UPDATE OR DELETE ON ai_provider_dispatch_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

ALTER TABLE execution_attempts
    ADD COLUMN IF NOT EXISTS provider_dispatch_decision_id uuid;

ALTER TABLE execution_attempts
    ADD CONSTRAINT execution_attempt_provider_dispatch_evidence_fk
        FOREIGN KEY(provider_dispatch_decision_id, project_id)
        REFERENCES ai_provider_dispatch_decisions(id, project_id) ON DELETE RESTRICT;

ALTER TABLE task_context_packs
    ADD COLUMN IF NOT EXISTS provider_dispatch_decision_id uuid;

ALTER TABLE task_context_packs
    ADD CONSTRAINT task_context_pack_provider_dispatch_evidence_fk
        FOREIGN KEY(provider_dispatch_decision_id, project_id)
        REFERENCES ai_provider_dispatch_decisions(id, project_id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION enforce_execution_attempt_provider_dispatch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    budget_class text;
    dispatch record;
BEGIN
    SELECT execution_class
      INTO budget_class
      FROM ai_budget_decisions
     WHERE id = NEW.ai_budget_decision_id
       AND project_id = NEW.project_id;

    IF budget_class IS NULL THEN
        RAISE EXCEPTION 'Provider dispatch conflict: execution attempt has no valid budget evidence';
    END IF;

    IF budget_class = 'DETERMINISTIC' THEN
        IF NEW.provider_dispatch_decision_id IS NOT NULL THEN
            RAISE EXCEPTION 'Provider dispatch conflict: deterministic work must not bind provider dispatch evidence';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.provider_dispatch_decision_id IS NULL THEN
        RAISE EXCEPTION 'Provider dispatch conflict: AI work requires provider dispatch evidence';
    END IF;

    SELECT dispatch_decision.*,
           observation.status AS observation_status,
           observation.expires_at AS observation_expires_at
      INTO dispatch
      FROM ai_provider_dispatch_decisions dispatch_decision
      JOIN ai_provider_capacity_observations observation
        ON observation.id = dispatch_decision.capacity_observation_id
       AND observation.project_id = dispatch_decision.project_id
     WHERE dispatch_decision.id = NEW.provider_dispatch_decision_id
       AND dispatch_decision.project_id = NEW.project_id
       AND dispatch_decision.work_queue_item_id = NEW.work_queue_item_id
       AND dispatch_decision.queue_state_version = NEW.claim_queue_state_version
       AND dispatch_decision.ai_budget_decision_id = NEW.ai_budget_decision_id
       AND dispatch_decision.capability = 'CODE_BUILDER';

    IF dispatch.id IS NULL
       OR dispatch.outcome <> 'READY'
       OR dispatch.waiting_reason <> 'NONE'
       OR dispatch.observation_status <> 'HEALTHY'
       OR dispatch.observation_expires_at <= now() THEN
        RAISE EXCEPTION 'Provider dispatch conflict: AI work does not have fresh READY provider capacity';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_attempt_provider_dispatch_gate ON execution_attempts;
CREATE TRIGGER execution_attempt_provider_dispatch_gate
BEFORE INSERT ON execution_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_execution_attempt_provider_dispatch();
