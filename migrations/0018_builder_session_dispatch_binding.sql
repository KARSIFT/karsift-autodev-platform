ALTER TABLE builder_sessions
    ADD COLUMN IF NOT EXISTS builder_dispatch_claim_id uuid,
    ADD COLUMN IF NOT EXISTS builder_dispatch_revalidation_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'builder_sessions_dispatch_claim_fk'
    ) THEN
        ALTER TABLE builder_sessions
            ADD CONSTRAINT builder_sessions_dispatch_claim_fk
            FOREIGN KEY(builder_dispatch_claim_id, project_id)
            REFERENCES builder_dispatch_claims(id, project_id) ON DELETE RESTRICT;
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'builder_sessions_dispatch_revalidation_fk'
    ) THEN
        ALTER TABLE builder_sessions
            ADD CONSTRAINT builder_sessions_dispatch_revalidation_fk
            FOREIGN KEY(builder_dispatch_revalidation_id, project_id)
            REFERENCES builder_dispatch_revalidations(id, project_id) ON DELETE RESTRICT;
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'builder_sessions_dispatch_binding_pair_check'
    ) THEN
        ALTER TABLE builder_sessions
            ADD CONSTRAINT builder_sessions_dispatch_binding_pair_check CHECK (
                (builder_dispatch_claim_id IS NULL AND builder_dispatch_revalidation_id IS NULL)
                OR
                (builder_dispatch_claim_id IS NOT NULL AND builder_dispatch_revalidation_id IS NOT NULL)
            );
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_builder_session_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    claim_row record;
    revalidation_row record;
BEGIN
    IF NEW.state_version <> OLD.state_version + 1 THEN
        RAISE EXCEPTION 'Builder session conflict: state version must advance by one';
    END IF;

    IF NEW.builder_session_plan_id <> OLD.builder_session_plan_id
       OR NEW.project_id <> OLD.project_id
       OR NEW.builder_invocation_id <> OLD.builder_invocation_id THEN
        RAISE EXCEPTION 'Builder session conflict: immutable session binding cannot change';
    END IF;

    IF OLD.status IN ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED') THEN
        RAISE EXCEPTION 'Builder session conflict: terminal session cannot transition';
    END IF;

    IF NEW.builder_dispatch_claim_id IS NOT NULL THEN
        SELECT claim.*
          INTO claim_row
          FROM builder_dispatch_claims claim
         WHERE claim.id = NEW.builder_dispatch_claim_id
           AND claim.project_id = NEW.project_id;

        SELECT revalidation.*
          INTO revalidation_row
          FROM builder_dispatch_revalidations revalidation
         WHERE revalidation.id = NEW.builder_dispatch_revalidation_id
           AND revalidation.project_id = NEW.project_id;

        IF claim_row.id IS NULL
           OR claim_row.builder_invocation_id <> NEW.builder_invocation_id
           OR revalidation_row.id IS NULL
           OR revalidation_row.builder_dispatch_claim_id <> claim_row.id
           OR revalidation_row.builder_invocation_id <> NEW.builder_invocation_id
           OR revalidation_row.outcome <> 'READY' THEN
            RAISE EXCEPTION 'Builder session conflict: dispatch binding is not exact READY evidence';
        END IF;
    END IF;

    IF OLD.status = 'PREPARED'
       AND NEW.status IN ('READY_FOR_TURN', 'FAILED', 'CANCELLED') THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'READY_FOR_TURN'
       AND NEW.status IN ('READY_FOR_TURN', 'WAITING_ACTION', 'FAILED', 'CANCELLED') THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'WAITING_ACTION'
       AND NEW.status IN (
           'WAITING_ACTION', 'READY_FOR_TURN', 'REFRESH_CONTEXT',
           'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'
       ) THEN
        IF NEW.status IN ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED')
           AND NOT EXISTS (
               SELECT 1
                 FROM builder_session_evidence evidence
                WHERE evidence.builder_session_id = OLD.id
                  AND evidence.project_id = OLD.project_id
                  AND evidence.outcome = NEW.status
           ) THEN
            RAISE EXCEPTION 'Builder session conflict: terminal evidence is required';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'REFRESH_CONTEXT'
       AND NEW.status IN ('WAITING_REFRESH_CONTEXT', 'FAILED', 'CANCELLED') THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'WAITING_REFRESH_CONTEXT'
       AND NEW.status IN ('WAITING_REFRESH_CONTEXT', 'READY_FOR_TURN', 'FAILED', 'CANCELLED') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Builder session conflict: invalid state transition';
END;
$$;
