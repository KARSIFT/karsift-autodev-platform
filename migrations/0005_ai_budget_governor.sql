CREATE TABLE IF NOT EXISTS ai_budget_policies (
    project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
    monthly_limit_microusd bigint NOT NULL CHECK (monthly_limit_microusd >= 0),
    per_work_limit_microusd bigint NOT NULL CHECK (per_work_limit_microusd >= 0),
    max_ai_tier smallint NOT NULL CHECK (max_ai_tier BETWEEN 0 AND 4),
    enabled boolean NOT NULL DEFAULT true,
    updated_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_budget_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    work_queue_item_id uuid NOT NULL,
    queue_state_version integer NOT NULL CHECK (queue_state_version >= 0),
    execution_class text NOT NULL CHECK (execution_class IN (
        'DETERMINISTIC', 'AI_TIER_1', 'AI_TIER_2', 'AI_TIER_3', 'AI_TIER_4'
    )),
    estimated_max_cost_microusd bigint NOT NULL CHECK (estimated_max_cost_microusd >= 0),
    decision text NOT NULL CHECK (decision IN ('APPROVED', 'DENIED', 'DEFERRED')),
    reason_code text NOT NULL CHECK (reason_code IN (
        'NO_AI_REQUIRED',
        'BUDGET_RESERVED',
        'BUDGET_POLICY_MISSING',
        'BUDGET_GOVERNOR_DISABLED',
        'EXECUTION_CLASS_NOT_ALLOWED',
        'PER_WORK_LIMIT_EXCEEDED',
        'PERIOD_BUDGET_EXHAUSTED'
    )),
    period_start date NOT NULL,
    policy_monthly_limit_microusd bigint,
    policy_per_work_limit_microusd bigint,
    policy_max_ai_tier smallint,
    committed_and_reserved_microusd bigint NOT NULL DEFAULT 0 CHECK (committed_and_reserved_microusd >= 0),
    actor_type text NOT NULL CHECK (actor_type IN ('FOUNDER', 'HUMAN', 'SYSTEM', 'AGENT')),
    actor_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    FOREIGN KEY(work_queue_item_id, project_id)
        REFERENCES work_queue_items(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS ai_budget_decisions_work_state_idx
    ON ai_budget_decisions(work_queue_item_id, queue_state_version, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ai_budget_decisions_project_idx
    ON ai_budget_decisions(project_id, period_start, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_budget_reservations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    budget_decision_id uuid NOT NULL UNIQUE,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    work_queue_item_id uuid NOT NULL,
    queue_state_version integer NOT NULL CHECK (queue_state_version >= 0),
    period_start date NOT NULL,
    reserved_microusd bigint NOT NULL CHECK (reserved_microusd > 0),
    status text NOT NULL DEFAULT 'RESERVED'
        CHECK (status IN ('RESERVED', 'COMMITTED', 'SETTLED', 'RELEASED')),
    execution_attempt_id uuid,
    actual_cost_microusd bigint CHECK (actual_cost_microusd >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    committed_at timestamptz,
    settled_at timestamptz,
    released_at timestamptz,
    UNIQUE(id, project_id),
    FOREIGN KEY(budget_decision_id, project_id)
        REFERENCES ai_budget_decisions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(work_queue_item_id, project_id)
        REFERENCES work_queue_items(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(execution_attempt_id, project_id)
        REFERENCES execution_attempts(id, project_id) ON DELETE RESTRICT,
    CHECK (
        (status = 'SETTLED' AND actual_cost_microusd IS NOT NULL AND settled_at IS NOT NULL)
        OR status <> 'SETTLED'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_budget_one_live_reservation_per_work_idx
    ON ai_budget_reservations(work_queue_item_id)
    WHERE status IN ('RESERVED', 'COMMITTED');
CREATE INDEX IF NOT EXISTS ai_budget_reservations_period_idx
    ON ai_budget_reservations(project_id, period_start, status);

DROP TRIGGER IF EXISTS ai_budget_decisions_immutable ON ai_budget_decisions;
CREATE TRIGGER ai_budget_decisions_immutable
BEFORE UPDATE OR DELETE ON ai_budget_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

CREATE OR REPLACE FUNCTION release_stale_ai_budget_reservations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.state_version <> OLD.state_version THEN
        UPDATE ai_budget_reservations
           SET status = 'RELEASED',
               released_at = now()
         WHERE work_queue_item_id = NEW.id
           AND status = 'RESERVED'
           AND queue_state_version <> NEW.state_version;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS work_queue_release_stale_ai_budget_reservations ON work_queue_items;
CREATE TRIGGER work_queue_release_stale_ai_budget_reservations
AFTER UPDATE OF state_version ON work_queue_items
FOR EACH ROW EXECUTE FUNCTION release_stale_ai_budget_reservations();

CREATE OR REPLACE FUNCTION enforce_execution_attempt_budget_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    latest_decision record;
BEGIN
    SELECT budget_decision.id,
           budget_decision.execution_class,
           budget_decision.decision
      INTO latest_decision
      FROM work_queue_items work
      JOIN ai_budget_decisions budget_decision
        ON budget_decision.work_queue_item_id = work.id
       AND budget_decision.project_id = work.project_id
       AND budget_decision.queue_state_version = work.state_version
     WHERE work.id = NEW.work_queue_item_id
       AND work.project_id = NEW.project_id
     ORDER BY budget_decision.created_at DESC, budget_decision.id DESC
     LIMIT 1;

    IF latest_decision.id IS NULL OR latest_decision.decision <> 'APPROVED' THEN
        RAISE EXCEPTION 'Execution budget conflict: current queue state has no approved budget decision';
    END IF;

    IF latest_decision.execution_class <> 'DETERMINISTIC' AND NOT EXISTS (
        SELECT 1
          FROM ai_budget_reservations reservation
         WHERE reservation.budget_decision_id = latest_decision.id
           AND reservation.project_id = NEW.project_id
           AND reservation.work_queue_item_id = NEW.work_queue_item_id
           AND reservation.status = 'RESERVED'
    ) THEN
        RAISE EXCEPTION 'Execution budget conflict: approved AI work has no active cost reservation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_attempt_budget_authorization_gate ON execution_attempts;
CREATE TRIGGER execution_attempt_budget_authorization_gate
BEFORE INSERT ON execution_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_execution_attempt_budget_authorization();

CREATE OR REPLACE FUNCTION commit_ai_budget_reservation_for_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE ai_budget_reservations reservation
       SET status = 'COMMITTED',
           execution_attempt_id = NEW.id,
           committed_at = now()
      FROM ai_budget_decisions budget_decision,
           work_queue_items work
     WHERE work.id = NEW.work_queue_item_id
       AND work.project_id = NEW.project_id
       AND budget_decision.work_queue_item_id = work.id
       AND budget_decision.project_id = work.project_id
       AND budget_decision.queue_state_version = work.state_version
       AND budget_decision.decision = 'APPROVED'
       AND budget_decision.execution_class <> 'DETERMINISTIC'
       AND reservation.budget_decision_id = budget_decision.id
       AND reservation.status = 'RESERVED';
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_attempt_commit_ai_budget_reservation ON execution_attempts;
CREATE TRIGGER execution_attempt_commit_ai_budget_reservation
AFTER INSERT ON execution_attempts
FOR EACH ROW EXECUTE FUNCTION commit_ai_budget_reservation_for_attempt();

CREATE OR REPLACE FUNCTION release_ai_budget_reservation_for_abandoned_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status = 'ACTIVE' AND NEW.status IN ('RELEASED', 'EXPIRED') THEN
        UPDATE ai_budget_reservations
           SET status = 'RELEASED',
               released_at = now()
         WHERE execution_attempt_id = NEW.id
           AND project_id = NEW.project_id
           AND status = 'COMMITTED';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_attempt_release_ai_budget_reservation ON execution_attempts;
CREATE TRIGGER execution_attempt_release_ai_budget_reservation
AFTER UPDATE OF status ON execution_attempts
FOR EACH ROW EXECUTE FUNCTION release_ai_budget_reservation_for_abandoned_attempt();

CREATE OR REPLACE FUNCTION require_ai_budget_settlement_before_terminal_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status = 'ACTIVE' AND NEW.status IN ('SUCCEEDED', 'FAILED') AND EXISTS (
        SELECT 1
          FROM ai_budget_reservations
         WHERE execution_attempt_id = NEW.id
           AND project_id = NEW.project_id
           AND status = 'COMMITTED'
    ) THEN
        RAISE EXCEPTION 'Execution budget conflict: AI reservation must be settled before terminal completion';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_attempt_require_ai_budget_settlement ON execution_attempts;
CREATE TRIGGER execution_attempt_require_ai_budget_settlement
BEFORE UPDATE OF status ON execution_attempts
FOR EACH ROW EXECUTE FUNCTION require_ai_budget_settlement_before_terminal_attempt();
