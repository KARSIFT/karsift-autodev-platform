CREATE OR REPLACE FUNCTION enforce_builder_proposal_action_decision_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    request_row record;
    proposal_run_row record;
    proposal_evidence_row record;
    invocation_row record;
    invocation_plan_row record;
    workspace_row record;
    command_policy_row record;
    proposal_count integer;
    existing_command_count integer;
    command_row jsonb;
BEGIN
    SELECT run.*
      INTO proposal_run_row
      FROM builder_proposal_runs run
     WHERE run.id = NEW.builder_proposal_run_id
       AND run.project_id = NEW.project_id;

    SELECT request.*
      INTO request_row
      FROM builder_proposal_requests request
     WHERE request.id = NEW.builder_proposal_request_id
       AND request.project_id = NEW.project_id;

    SELECT evidence.*
      INTO proposal_evidence_row
      FROM builder_proposal_evidence evidence
     WHERE evidence.id = NEW.builder_proposal_evidence_id
       AND evidence.project_id = NEW.project_id;

    SELECT invocation.*
      INTO invocation_row
      FROM builder_invocations invocation
     WHERE invocation.id = NEW.builder_invocation_id
       AND invocation.project_id = NEW.project_id;

    IF proposal_run_row.id IS NULL
       OR proposal_run_row.status <> 'GENERATED'
       OR proposal_run_row.builder_proposal_request_id <> NEW.builder_proposal_request_id
       OR proposal_run_row.builder_invocation_id <> NEW.builder_invocation_id
       OR request_row.id IS NULL
       OR request_row.builder_invocation_id <> NEW.builder_invocation_id
       OR proposal_evidence_row.id IS NULL
       OR proposal_evidence_row.builder_proposal_run_id <> NEW.builder_proposal_run_id
       OR proposal_evidence_row.outcome <> 'GENERATED'
       OR proposal_evidence_row.proposal_action <> NEW.action
       OR proposal_evidence_row.proposal_hash <> NEW.proposal_hash
       OR invocation_row.id IS NULL
       OR invocation_row.status <> 'PREPARED' THEN
        RAISE EXCEPTION 'Builder proposal action decision conflict: proposal evidence is not current and generated';
    END IF;

    SELECT plan.*
      INTO invocation_plan_row
      FROM builder_invocation_plans plan
     WHERE plan.id = invocation_row.builder_invocation_plan_id
       AND plan.project_id = NEW.project_id;

    SELECT workspace.*,
           workspace_plan.mode AS workspace_mode
      INTO workspace_row
      FROM workspace_read_context_snapshots snapshot
      JOIN workspace_read_context_runs capture_run
        ON capture_run.id = snapshot.workspace_read_context_run_id
       AND capture_run.project_id = snapshot.project_id
      JOIN workspace_read_context_requests capture_request
        ON capture_request.id = capture_run.workspace_read_context_request_id
       AND capture_request.project_id = capture_run.project_id
      JOIN repository_workspaces workspace
        ON workspace.id = capture_request.repository_workspace_id
       AND workspace.project_id = capture_request.project_id
      JOIN repository_workspace_plans workspace_plan
        ON workspace_plan.id = workspace.repository_workspace_plan_id
       AND workspace_plan.project_id = workspace.project_id
     WHERE snapshot.id = request_row.workspace_read_context_snapshot_id
       AND snapshot.project_id = NEW.project_id
       AND workspace.id = NEW.repository_workspace_id;

    IF invocation_plan_row.id IS NULL
       OR workspace_row.id IS NULL
       OR workspace_row.state_version <> NEW.workspace_state_version
       OR request_row.task_context_pack_id <> NEW.task_context_pack_id
       OR request_row.task_context_pack_hash <> NEW.task_context_pack_hash
       OR invocation_plan_row.task_context_pack_id <> NEW.task_context_pack_id
       OR invocation_plan_row.task_context_pack_hash <> NEW.task_context_pack_hash THEN
        RAISE EXCEPTION 'Builder proposal action decision conflict: workspace or Task Context Pack evidence does not match';
    END IF;

    IF NEW.action NOT IN ('COMPLETE', 'BLOCKED')
       AND workspace_row.status <> 'MATERIALIZED' THEN
        RAISE EXCEPTION 'Builder proposal action decision conflict: non-terminal action requires MATERIALIZED workspace';
    END IF;

    SELECT count(*)::integer
      INTO proposal_count
      FROM builder_proposal_requests request
     WHERE request.project_id = NEW.project_id
       AND request.builder_invocation_id = NEW.builder_invocation_id;

    IF NEW.turn_number <> proposal_count
       OR NEW.turn_number > invocation_plan_row.max_turns THEN
        RAISE EXCEPTION 'Builder proposal action decision conflict: turn number exceeds immutable builder limits';
    END IF;

    IF NEW.action = 'REQUEST_COMMANDS' THEN
        SELECT policy.*
          INTO command_policy_row
          FROM workspace_command_policies policy
         WHERE policy.id = NEW.command_policy_id
           AND policy.project_id = NEW.project_id;

        IF command_policy_row.id IS NULL
           OR command_policy_row.enabled IS NOT TRUE
           OR command_policy_row.policy_hash <> NEW.command_policy_hash THEN
            RAISE EXCEPTION 'Builder proposal action decision conflict: command policy is missing, disabled, or stale';
        END IF;

        IF jsonb_array_length(proposal_evidence_row.proposal_content->'commands') = 0
           OR jsonb_array_length(proposal_evidence_row.proposal_content->'commands') > command_policy_row.max_commands_per_workspace THEN
            RAISE EXCEPTION 'Builder proposal action decision conflict: proposed command count exceeds policy';
        END IF;

        SELECT count(*)::integer
          INTO existing_command_count
          FROM workspace_command_plans plan
         WHERE plan.project_id = NEW.project_id
           AND plan.repository_workspace_id = NEW.repository_workspace_id;

        IF existing_command_count
           + jsonb_array_length(proposal_evidence_row.proposal_content->'commands')
           > command_policy_row.max_commands_per_workspace THEN
            RAISE EXCEPTION 'Builder proposal action decision conflict: workspace command budget would be exceeded';
        END IF;

        FOR command_row IN
            SELECT value FROM jsonb_array_elements(proposal_evidence_row.proposal_content->'commands')
        LOOP
            IF NOT (command_policy_row.purposes ? (command_row->>'purpose')) THEN
                RAISE EXCEPTION 'Builder proposal action decision conflict: command purpose is not allowed by policy';
            END IF;
            IF NOT EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(command_policy_row.rules) AS rule
                 WHERE rule->>'executable' = command_row->>'executable'
                   AND EXISTS (
                       SELECT 1
                         FROM jsonb_array_elements(rule->'allowedArguments') AS allowed_arguments
                        WHERE allowed_arguments = command_row->'arguments'
                   )
            ) THEN
                RAISE EXCEPTION 'Builder proposal action decision conflict: proposed command is not allowed by policy';
            END IF;
        END LOOP;
    ELSE
        IF NEW.command_policy_id IS NOT NULL OR NEW.command_policy_hash IS NOT NULL THEN
            RAISE EXCEPTION 'Builder proposal action decision conflict: non-command action cannot carry command policy';
        END IF;
    END IF;

    IF NEW.action = 'PROPOSE_MUTATIONS' THEN
        IF workspace_row.workspace_mode <> 'WRITE'
           OR NOT is_effective_capability_enabled(NEW.project_id, 'AUTOMATED_WRITE') THEN
            RAISE EXCEPTION 'Builder proposal action decision conflict: WRITE workspace authority is not active';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
