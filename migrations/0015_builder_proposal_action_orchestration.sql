CREATE TABLE IF NOT EXISTS builder_proposal_action_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_invocation_id uuid NOT NULL,
    builder_proposal_request_id uuid NOT NULL,
    builder_proposal_run_id uuid NOT NULL,
    builder_proposal_evidence_id uuid NOT NULL,
    repository_workspace_id uuid NOT NULL,
    workspace_state_version integer NOT NULL CHECK (workspace_state_version >= 0),
    task_context_pack_id uuid NOT NULL,
    task_context_pack_hash text NOT NULL CHECK (task_context_pack_hash ~ '^[a-f0-9]{64}$'),
    turn_number integer NOT NULL CHECK (turn_number > 0),
    action text NOT NULL CHECK (action IN (
        'COMPLETE', 'REQUEST_CONTEXT', 'REQUEST_COMMANDS', 'PROPOSE_MUTATIONS', 'BLOCKED'
    )),
    proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
    command_policy_id uuid,
    command_policy_hash text CHECK (
        command_policy_hash IS NULL OR command_policy_hash ~ '^[a-f0-9]{64}$'
    ),
    decision_content jsonb NOT NULL,
    decision_hash text NOT NULL CHECK (decision_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(builder_proposal_evidence_id),
    UNIQUE(builder_invocation_id, turn_number),
    FOREIGN KEY(builder_invocation_id, project_id)
        REFERENCES builder_invocations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(builder_proposal_request_id, project_id)
        REFERENCES builder_proposal_requests(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(builder_proposal_run_id, project_id)
        REFERENCES builder_proposal_runs(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(builder_proposal_evidence_id, project_id)
        REFERENCES builder_proposal_evidence(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(repository_workspace_id, project_id)
        REFERENCES repository_workspaces(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(task_context_pack_id, project_id)
        REFERENCES task_context_packs(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(command_policy_id, project_id)
        REFERENCES workspace_command_policies(id, project_id) ON DELETE RESTRICT,
    CHECK (
        (action = 'REQUEST_COMMANDS' AND command_policy_id IS NOT NULL AND command_policy_hash IS NOT NULL)
        OR
        (action <> 'REQUEST_COMMANDS' AND command_policy_id IS NULL AND command_policy_hash IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS builder_proposal_action_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_proposal_action_decision_id uuid NOT NULL,
    builder_invocation_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'PREPARED'
        CHECK (status IN ('PREPARED', 'MATERIALIZED', 'SATISFIED')),
    state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    materialized_entities jsonb NOT NULL DEFAULT '[]'::jsonb,
    materialized_at timestamptz,
    satisfied_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(builder_proposal_action_decision_id),
    FOREIGN KEY(builder_proposal_action_decision_id, project_id)
        REFERENCES builder_proposal_action_decisions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY(builder_invocation_id, project_id)
        REFERENCES builder_invocations(id, project_id) ON DELETE RESTRICT,
    CHECK (jsonb_typeof(materialized_entities) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS builder_proposal_action_one_active_per_invocation_idx
    ON builder_proposal_action_runs(project_id, builder_invocation_id)
    WHERE status IN ('PREPARED', 'MATERIALIZED');

CREATE TABLE IF NOT EXISTS builder_proposal_action_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    builder_proposal_action_run_id uuid NOT NULL,
    action text NOT NULL CHECK (action IN (
        'COMPLETE', 'REQUEST_CONTEXT', 'REQUEST_COMMANDS', 'PROPOSE_MUTATIONS', 'BLOCKED'
    )),
    outcome text NOT NULL CHECK (outcome IN ('TERMINAL', 'RESULT_READY')),
    result_content jsonb NOT NULL,
    result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, project_id),
    UNIQUE(builder_proposal_action_run_id),
    FOREIGN KEY(builder_proposal_action_run_id, project_id)
        REFERENCES builder_proposal_action_runs(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS builder_proposal_action_runs_project_status_idx
    ON builder_proposal_action_runs(project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS builder_proposal_action_decisions_invocation_idx
    ON builder_proposal_action_decisions(builder_invocation_id, turn_number DESC);

ALTER TABLE builder_proposal_requests
    ADD COLUMN IF NOT EXISTS previous_action_evidence_id uuid,
    ADD COLUMN IF NOT EXISTS previous_action_evidence_hash text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'builder_proposal_requests_previous_action_evidence_fk'
    ) THEN
        ALTER TABLE builder_proposal_requests
            ADD CONSTRAINT builder_proposal_requests_previous_action_evidence_fk
            FOREIGN KEY(previous_action_evidence_id, project_id)
            REFERENCES builder_proposal_action_evidence(id, project_id) ON DELETE RESTRICT;
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'builder_proposal_requests_previous_action_pair_check'
    ) THEN
        ALTER TABLE builder_proposal_requests
            ADD CONSTRAINT builder_proposal_requests_previous_action_pair_check CHECK (
                (previous_action_evidence_id IS NULL AND previous_action_evidence_hash IS NULL)
                OR
                (previous_action_evidence_id IS NOT NULL
                 AND previous_action_evidence_hash ~ '^[a-f0-9]{64}$')
            );
    END IF;
END
$$;

DROP TRIGGER IF EXISTS builder_proposal_action_decisions_immutable
    ON builder_proposal_action_decisions;
CREATE TRIGGER builder_proposal_action_decisions_immutable
BEFORE UPDATE OR DELETE ON builder_proposal_action_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

DROP TRIGGER IF EXISTS builder_proposal_action_evidence_immutable
    ON builder_proposal_action_evidence;
CREATE TRIGGER builder_proposal_action_evidence_immutable
BEFORE UPDATE OR DELETE ON builder_proposal_action_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

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
       OR workspace_row.status <> 'MATERIALIZED'
       OR workspace_row.state_version <> NEW.workspace_state_version
       OR request_row.task_context_pack_id <> NEW.task_context_pack_id
       OR request_row.task_context_pack_hash <> NEW.task_context_pack_hash
       OR invocation_plan_row.task_context_pack_id <> NEW.task_context_pack_id
       OR invocation_plan_row.task_context_pack_hash <> NEW.task_context_pack_hash THEN
        RAISE EXCEPTION 'Builder proposal action decision conflict: workspace or Task Context Pack evidence does not match';
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

DROP TRIGGER IF EXISTS builder_proposal_action_decision_authority_gate
    ON builder_proposal_action_decisions;
CREATE TRIGGER builder_proposal_action_decision_authority_gate
BEFORE INSERT ON builder_proposal_action_decisions
FOR EACH ROW EXECUTE FUNCTION enforce_builder_proposal_action_decision_authority();

CREATE OR REPLACE FUNCTION enforce_builder_proposal_action_run_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    decision_row record;
    proposal_evidence_row record;
    entity_row jsonb;
    command_row jsonb;
    child_row record;
    entity_ordinal integer;
BEGIN
    IF NEW.state_version <> OLD.state_version + 1 THEN
        RAISE EXCEPTION 'Builder proposal action run conflict: state version must advance by one';
    END IF;

    SELECT decision.*
      INTO decision_row
      FROM builder_proposal_action_decisions decision
     WHERE decision.id = OLD.builder_proposal_action_decision_id
       AND decision.project_id = OLD.project_id;

    SELECT evidence.*
      INTO proposal_evidence_row
      FROM builder_proposal_evidence evidence
     WHERE evidence.id = decision_row.builder_proposal_evidence_id
       AND evidence.project_id = OLD.project_id;

    IF OLD.status = 'PREPARED' AND NEW.status = 'MATERIALIZED' THEN
        IF NEW.materialized_at IS NULL OR NEW.satisfied_at IS NOT NULL THEN
            RAISE EXCEPTION 'Builder proposal action run conflict: MATERIALIZED timestamps are invalid';
        END IF;

        IF decision_row.action IN ('COMPLETE', 'BLOCKED') THEN
            IF jsonb_array_length(NEW.materialized_entities) <> 0 THEN
                RAISE EXCEPTION 'Builder proposal action run conflict: terminal actions cannot materialize destination work';
            END IF;
        ELSIF decision_row.action = 'REQUEST_CONTEXT' THEN
            IF jsonb_array_length(NEW.materialized_entities) <> 1 THEN
                RAISE EXCEPTION 'Builder proposal action run conflict: context action must materialize exactly one request';
            END IF;
            entity_row := NEW.materialized_entities->0;
            SELECT run.id AS run_id,
                   request.id AS record_id,
                   request.repository_workspace_id,
                   request.requested_paths
              INTO child_row
              FROM workspace_read_context_runs run
              JOIN workspace_read_context_requests request
                ON request.id = run.workspace_read_context_request_id
               AND request.project_id = run.project_id
             WHERE run.id = entity_row->>'runId'
               AND request.id = entity_row->>'recordId'
               AND run.project_id = OLD.project_id;
            IF entity_row->>'kind' <> 'WORKSPACE_READ_CONTEXT'
               OR (entity_row->>'ordinal')::integer <> 0
               OR child_row.run_id IS NULL
               OR child_row.repository_workspace_id <> decision_row.repository_workspace_id
               OR child_row.requested_paths <> proposal_evidence_row.proposal_content->'requestedPaths' THEN
                RAISE EXCEPTION 'Builder proposal action run conflict: context destination evidence does not match proposal';
            END IF;
        ELSIF decision_row.action = 'REQUEST_COMMANDS' THEN
            IF jsonb_array_length(NEW.materialized_entities)
               <> jsonb_array_length(proposal_evidence_row.proposal_content->'commands') THEN
                RAISE EXCEPTION 'Builder proposal action run conflict: command materialization count does not match proposal';
            END IF;
            FOR entity_row, entity_ordinal IN
                SELECT value, (ordinality - 1)::integer
                  FROM jsonb_array_elements(NEW.materialized_entities) WITH ORDINALITY
            LOOP
                command_row := proposal_evidence_row.proposal_content->'commands'->entity_ordinal;
                SELECT run.id AS run_id,
                       plan.id AS record_id,
                       plan.repository_workspace_id,
                       plan.workspace_command_policy_id,
                       plan.policy_hash,
                       plan.purpose,
                       plan.executable,
                       plan.arguments
                  INTO child_row
                  FROM workspace_command_runs run
                  JOIN workspace_command_plans plan
                    ON plan.id = run.workspace_command_plan_id
                   AND plan.project_id = run.project_id
                 WHERE run.id = entity_row->>'runId'
                   AND plan.id = entity_row->>'recordId'
                   AND run.project_id = OLD.project_id;
                IF entity_row->>'kind' <> 'WORKSPACE_COMMAND'
                   OR (entity_row->>'ordinal')::integer <> entity_ordinal
                   OR child_row.run_id IS NULL
                   OR child_row.repository_workspace_id <> decision_row.repository_workspace_id
                   OR child_row.workspace_command_policy_id <> decision_row.command_policy_id
                   OR child_row.policy_hash <> decision_row.command_policy_hash
                   OR child_row.purpose <> command_row->>'purpose'
                   OR child_row.executable <> command_row->>'executable'
                   OR child_row.arguments <> command_row->'arguments' THEN
                    RAISE EXCEPTION 'Builder proposal action run conflict: command destination evidence does not match proposal';
                END IF;
            END LOOP;
        ELSIF decision_row.action = 'PROPOSE_MUTATIONS' THEN
            IF jsonb_array_length(NEW.materialized_entities) <> 1 THEN
                RAISE EXCEPTION 'Builder proposal action run conflict: mutation action must materialize exactly one plan';
            END IF;
            entity_row := NEW.materialized_entities->0;
            SELECT run.id AS run_id,
                   plan.id AS record_id,
                   plan.repository_workspace_id,
                   plan.operations
              INTO child_row
              FROM workspace_mutation_runs run
              JOIN workspace_mutation_plans plan
                ON plan.id = run.workspace_mutation_plan_id
               AND plan.project_id = run.project_id
             WHERE run.id = entity_row->>'runId'
               AND plan.id = entity_row->>'recordId'
               AND run.project_id = OLD.project_id;
            IF entity_row->>'kind' <> 'WORKSPACE_MUTATION'
               OR (entity_row->>'ordinal')::integer <> 0
               OR child_row.run_id IS NULL
               OR child_row.repository_workspace_id <> decision_row.repository_workspace_id
               OR child_row.operations <> proposal_evidence_row.proposal_content->'mutations' THEN
                RAISE EXCEPTION 'Builder proposal action run conflict: mutation destination evidence does not match proposal';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'MATERIALIZED' AND NEW.status = 'SATISFIED' THEN
        IF NEW.materialized_entities <> OLD.materialized_entities
           OR NEW.materialized_at IS NULL
           OR NEW.satisfied_at IS NULL
           OR NOT EXISTS (
               SELECT 1
                 FROM builder_proposal_action_evidence evidence
                WHERE evidence.builder_proposal_action_run_id = OLD.id
                  AND evidence.project_id = OLD.project_id
           ) THEN
            RAISE EXCEPTION 'Builder proposal action run conflict: immutable terminal evidence is required';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Builder proposal action run conflict: invalid status transition';
END;
$$;

DROP TRIGGER IF EXISTS builder_proposal_action_run_transition_gate
    ON builder_proposal_action_runs;
CREATE TRIGGER builder_proposal_action_run_transition_gate
BEFORE UPDATE ON builder_proposal_action_runs
FOR EACH ROW EXECUTE FUNCTION enforce_builder_proposal_action_run_transition();

CREATE OR REPLACE FUNCTION enforce_builder_proposal_action_evidence_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    action_run_row record;
    decision_row record;
BEGIN
    SELECT run.*
      INTO action_run_row
      FROM builder_proposal_action_runs run
     WHERE run.id = NEW.builder_proposal_action_run_id
       AND run.project_id = NEW.project_id;

    SELECT decision.*
      INTO decision_row
      FROM builder_proposal_action_decisions decision
     WHERE decision.id = action_run_row.builder_proposal_action_decision_id
       AND decision.project_id = NEW.project_id;

    IF action_run_row.id IS NULL
       OR action_run_row.status <> 'MATERIALIZED'
       OR decision_row.id IS NULL
       OR decision_row.action <> NEW.action THEN
        RAISE EXCEPTION 'Builder proposal action evidence conflict: action run is not MATERIALIZED';
    END IF;

    IF decision_row.action IN ('COMPLETE', 'BLOCKED') AND NEW.outcome <> 'TERMINAL' THEN
        RAISE EXCEPTION 'Builder proposal action evidence conflict: terminal action requires TERMINAL outcome';
    END IF;
    IF decision_row.action NOT IN ('COMPLETE', 'BLOCKED') AND NEW.outcome <> 'RESULT_READY' THEN
        RAISE EXCEPTION 'Builder proposal action evidence conflict: non-terminal action requires RESULT_READY outcome';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_proposal_action_evidence_binding_gate
    ON builder_proposal_action_evidence;
CREATE TRIGGER builder_proposal_action_evidence_binding_gate
BEFORE INSERT ON builder_proposal_action_evidence
FOR EACH ROW EXECUTE FUNCTION enforce_builder_proposal_action_evidence_binding();

CREATE OR REPLACE FUNCTION enforce_builder_proposal_next_turn_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    invocation_row record;
    plan_row record;
    prior_proposal_count integer;
    latest_action_row record;
BEGIN
    SELECT invocation.*
      INTO invocation_row
      FROM builder_invocations invocation
     WHERE invocation.id = NEW.builder_invocation_id
       AND invocation.project_id = NEW.project_id;

    SELECT plan.*
      INTO plan_row
      FROM builder_invocation_plans plan
     WHERE plan.id = invocation_row.builder_invocation_plan_id
       AND plan.project_id = NEW.project_id;

    SELECT count(*)::integer
      INTO prior_proposal_count
      FROM builder_proposal_requests request
     WHERE request.project_id = NEW.project_id
       AND request.builder_invocation_id = NEW.builder_invocation_id;

    IF plan_row.id IS NULL OR prior_proposal_count >= plan_row.max_turns THEN
        RAISE EXCEPTION 'Builder proposal turn conflict: immutable maxTurns limit has been reached';
    END IF;

    IF prior_proposal_count = 0 THEN
        IF NEW.previous_action_evidence_id IS NOT NULL
           OR NEW.previous_action_evidence_hash IS NOT NULL THEN
            RAISE EXCEPTION 'Builder proposal turn conflict: first turn cannot reference previous action evidence';
        END IF;
        RETURN NEW;
    END IF;

    SELECT decision.turn_number,
           action_run.status,
           action_evidence.id AS evidence_id,
           action_evidence.result_hash AS evidence_hash
      INTO latest_action_row
      FROM builder_proposal_action_decisions decision
      JOIN builder_proposal_action_runs action_run
        ON action_run.builder_proposal_action_decision_id = decision.id
       AND action_run.project_id = decision.project_id
      JOIN builder_proposal_action_evidence action_evidence
        ON action_evidence.builder_proposal_action_run_id = action_run.id
       AND action_evidence.project_id = action_run.project_id
     WHERE decision.project_id = NEW.project_id
       AND decision.builder_invocation_id = NEW.builder_invocation_id
     ORDER BY decision.turn_number DESC
     LIMIT 1;

    IF latest_action_row.evidence_id IS NULL
       OR latest_action_row.turn_number <> prior_proposal_count
       OR latest_action_row.status <> 'SATISFIED'
       OR NEW.previous_action_evidence_id <> latest_action_row.evidence_id
       OR NEW.previous_action_evidence_hash <> latest_action_row.evidence_hash THEN
        RAISE EXCEPTION 'Builder proposal turn conflict: exact previous action evidence is required';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_proposal_next_turn_authority_gate
    ON builder_proposal_requests;
CREATE TRIGGER builder_proposal_next_turn_authority_gate
BEFORE INSERT ON builder_proposal_requests
FOR EACH ROW EXECUTE FUNCTION enforce_builder_proposal_next_turn_authority();
