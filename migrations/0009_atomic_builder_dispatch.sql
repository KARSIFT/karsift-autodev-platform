CREATE TABLE IF NOT EXISTS builder_dispatch_claims (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_invocation_id uuid NOT NULL,
    builder_invocation_plan_id uuid NOT NULL,
    plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
    idempotency_key text NOT NULL,
    claim_owner text NOT NULL CHECK (length(claim_owner) BETWEEN 1 AND 300),
    claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
    status text NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'COMPLETED', 'RELEASED', 'EXPIRED')),
    lease_expires_at timestamptz NOT NULL,
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    FOREIGN KEY(builder_invocation_id, project_id)
        REFERENCES builder_invocations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(builder_invocation_plan_id, project_id)
        REFERENCES builder_invocation_plans(id, project_id) ON DELETE RESTRICT,
    CHECK (idempotency_key = 'builder-dispatch:' || plan_hash),
    CHECK (
        (status = 'ACTIVE' AND completed_at IS NULL)
        OR (status <> 'ACTIVE' AND completed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS builder_dispatch_one_active_idx
    ON builder_dispatch_claims(builder_invocation_id)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS builder_dispatch_claim_expiry_idx
    ON builder_dispatch_claims(status, lease_expires_at)
    WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS builder_dispatch_revalidations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_dispatch_claim_id uuid NOT NULL,
    builder_invocation_id uuid NOT NULL,
    provider_dispatch_decision_id uuid NOT NULL,
    provider_key text NOT NULL,
    capability text NOT NULL CHECK (capability = 'CODE_BUILDER'),
    capacity_observation_id uuid,
    outcome text NOT NULL CHECK (outcome IN ('READY', 'WAIT')),
    waiting_reason text NOT NULL CHECK (
        waiting_reason IN ('NONE', 'QUOTA', 'PROVIDER_UNAVAILABLE')
    ),
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
    UNIQUE(builder_dispatch_claim_id),
    FOREIGN KEY(builder_dispatch_claim_id, project_id)
        REFERENCES builder_dispatch_claims(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(builder_invocation_id, project_id)
        REFERENCES builder_invocations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(provider_dispatch_decision_id, project_id)
        REFERENCES ai_provider_dispatch_decisions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(capacity_observation_id, project_id)
        REFERENCES ai_provider_capacity_observations(id, project_id) ON DELETE RESTRICT,
    CHECK (
        (outcome = 'READY' AND waiting_reason = 'NONE' AND capacity_observation_id IS NOT NULL)
        OR (outcome = 'WAIT' AND waiting_reason <> 'NONE')
    )
);

CREATE INDEX IF NOT EXISTS builder_dispatch_revalidation_invocation_idx
    ON builder_dispatch_revalidations(builder_invocation_id, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS builder_dispatch_revalidations_immutable
    ON builder_dispatch_revalidations;
CREATE TRIGGER builder_dispatch_revalidations_immutable
BEFORE UPDATE OR DELETE ON builder_dispatch_revalidations
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

CREATE OR REPLACE FUNCTION enforce_builder_dispatch_claim_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    invocation_row record;
    plan_row record;
BEGIN
    SELECT invocation.*
      INTO invocation_row
      FROM builder_invocations invocation
     WHERE invocation.id = NEW.builder_invocation_id
       AND invocation.project_id = NEW.project_id;

    IF invocation_row.id IS NULL
       OR invocation_row.status NOT IN ('PREPARED', 'RUNNING') THEN
        RAISE EXCEPTION 'Builder dispatch claim conflict: invocation is not dispatchable';
    END IF;

    SELECT plan.*
      INTO plan_row
      FROM builder_invocation_plans plan
     WHERE plan.id = NEW.builder_invocation_plan_id
       AND plan.project_id = NEW.project_id
       AND plan.execution_attempt_id = invocation_row.execution_attempt_id;

    IF plan_row.id IS NULL
       OR plan_row.id <> invocation_row.builder_invocation_plan_id
       OR plan_row.plan_hash <> NEW.plan_hash THEN
        RAISE EXCEPTION 'Builder dispatch claim conflict: immutable plan evidence does not match';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_dispatch_claim_evidence_gate ON builder_dispatch_claims;
CREATE TRIGGER builder_dispatch_claim_evidence_gate
BEFORE INSERT ON builder_dispatch_claims
FOR EACH ROW EXECUTE FUNCTION enforce_builder_dispatch_claim_evidence();

CREATE OR REPLACE FUNCTION enforce_builder_dispatch_claim_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status = 'ACTIVE' AND NEW.status IN ('COMPLETED', 'RELEASED', 'EXPIRED') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Builder dispatch claim conflict: invalid status transition';
END;
$$;

DROP TRIGGER IF EXISTS builder_dispatch_claim_transition_gate ON builder_dispatch_claims;
CREATE TRIGGER builder_dispatch_claim_transition_gate
BEFORE UPDATE OF status ON builder_dispatch_claims
FOR EACH ROW EXECUTE FUNCTION enforce_builder_dispatch_claim_transition();

CREATE OR REPLACE FUNCTION enforce_builder_dispatch_revalidation_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    claim_row record;
    plan_row record;
    dispatch_row record;
    observation_row record;
BEGIN
    SELECT claim.*
      INTO claim_row
      FROM builder_dispatch_claims claim
     WHERE claim.id = NEW.builder_dispatch_claim_id
       AND claim.project_id = NEW.project_id;

    IF claim_row.id IS NULL
       OR claim_row.builder_invocation_id <> NEW.builder_invocation_id THEN
        RAISE EXCEPTION 'Builder dispatch revalidation conflict: claim does not match invocation';
    END IF;

    SELECT plan.*
      INTO plan_row
      FROM builder_invocation_plans plan
     WHERE plan.id = claim_row.builder_invocation_plan_id
       AND plan.project_id = NEW.project_id;

    SELECT dispatch_decision.*
      INTO dispatch_row
      FROM ai_provider_dispatch_decisions dispatch_decision
     WHERE dispatch_decision.id = NEW.provider_dispatch_decision_id
       AND dispatch_decision.project_id = NEW.project_id;

    IF plan_row.id IS NULL
       OR dispatch_row.id IS NULL
       OR plan_row.provider_dispatch_decision_id <> dispatch_row.id
       OR plan_row.provider_key <> NEW.provider_key
       OR dispatch_row.provider_key <> NEW.provider_key
       OR dispatch_row.capability <> NEW.capability THEN
        RAISE EXCEPTION 'Builder dispatch revalidation conflict: provider evidence does not match plan';
    END IF;

    IF NEW.capacity_observation_id IS NULL THEN
        IF NEW.outcome <> 'WAIT'
           OR NEW.reason_code <> 'PROVIDER_OBSERVATION_MISSING'
           OR NEW.waiting_reason <> 'PROVIDER_UNAVAILABLE' THEN
            RAISE EXCEPTION 'Builder dispatch revalidation conflict: missing observation semantics are invalid';
        END IF;
        RETURN NEW;
    END IF;

    SELECT observation.*
      INTO observation_row
      FROM ai_provider_capacity_observations observation
     WHERE observation.id = NEW.capacity_observation_id
       AND observation.project_id = NEW.project_id
       AND observation.provider_key = NEW.provider_key
       AND observation.capability = NEW.capability;

    IF observation_row.id IS NULL THEN
        RAISE EXCEPTION 'Builder dispatch revalidation conflict: capacity observation does not match provider';
    END IF;

    IF NEW.outcome = 'READY' AND (
        observation_row.status <> 'HEALTHY'
        OR observation_row.expires_at <= now()
        OR NEW.reason_code <> 'PROVIDER_READY'
        OR NEW.waiting_reason <> 'NONE'
    ) THEN
        RAISE EXCEPTION 'Builder dispatch revalidation conflict: READY evidence is not currently healthy';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_dispatch_revalidation_evidence_gate
    ON builder_dispatch_revalidations;
CREATE TRIGGER builder_dispatch_revalidation_evidence_gate
BEFORE INSERT ON builder_dispatch_revalidations
FOR EACH ROW EXECUTE FUNCTION enforce_builder_dispatch_revalidation_evidence();
