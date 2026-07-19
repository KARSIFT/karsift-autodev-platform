CREATE OR REPLACE FUNCTION initialize_builder_session_resume_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    session_plan_row record;
    latest_proposal_row record;
    proposal_count integer;
BEGIN
    SELECT session_plan.*
      INTO session_plan_row
      FROM builder_session_plans session_plan
     WHERE session_plan.id = NEW.builder_session_plan_id
       AND session_plan.project_id = NEW.project_id;

    IF session_plan_row.id IS NULL THEN
        RAISE EXCEPTION 'Builder session conflict: session plan was not found';
    END IF;

    SELECT count(*)::integer
      INTO proposal_count
      FROM builder_proposal_requests request
     WHERE request.project_id = NEW.project_id
       AND request.builder_invocation_id = NEW.builder_invocation_id;

    SELECT proposal_run.id AS proposal_run_id
      INTO latest_proposal_row
      FROM builder_proposal_requests request
      JOIN builder_proposal_runs proposal_run
        ON proposal_run.builder_proposal_request_id = request.id
       AND proposal_run.project_id = request.project_id
     WHERE request.project_id = NEW.project_id
       AND request.builder_invocation_id = NEW.builder_invocation_id
     ORDER BY request.created_at DESC, request.id DESC
     LIMIT 1;

    NEW.turn_count := proposal_count;
    IF latest_proposal_row.proposal_run_id IS NOT NULL THEN
        NEW.current_proposal_run_id := latest_proposal_row.proposal_run_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_session_resume_state_gate ON builder_sessions;
CREATE TRIGGER builder_session_resume_state_gate
BEFORE INSERT ON builder_sessions
FOR EACH ROW EXECUTE FUNCTION initialize_builder_session_resume_state();
