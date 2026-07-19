import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  buildBuilderSessionPlanContent,
  buildBuilderSessionTerminalEvidenceContent,
  hashBuilderSessionPlan,
  hashBuilderSessionTerminalEvidence,
  type BuilderSessionStatus,
} from "../domain/builder-session.js";
import type { JsonValue } from "../domain/stable-json.js";
import type {
  AcquireBuilderSessionStepClaimInput,
  BuilderSessionStore,
  CompleteBuilderSessionStepClaimInput,
  HeartbeatBuilderSessionExecutionLeaseInput,
  PrepareBuilderSessionInput,
  RecordBuilderSessionTerminalEvidenceInput,
  ReleaseBuilderSessionStepClaimInput,
  TransitionBuilderSessionInput,
} from "./builder-session-types.js";
import type { Actor } from "./types.js";

interface SessionPreparationRow extends QueryResultRow {
  readonly project_id: string;
  readonly builder_invocation_id: string;
  readonly builder_invocation_plan_id: string;
  readonly builder_plan_hash: string;
  readonly execution_attempt_id: string;
  readonly task_context_pack_id: string;
  readonly task_context_pack_hash: string;
  readonly repository_workspace_id: string;
  readonly repository_workspace_plan_id: string;
  readonly initial_read_context_run_id: string;
  readonly max_turns: number;
}

function assertLeaseSeconds(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 30 || value > 3600) {
    throw new Error(`${field} must be a safe integer between 30 and 3600`);
  }
}

async function appendAudit(
  client: PoolClient,
  params: {
    projectId: string;
    actor: Actor;
    action: string;
    entityType: string;
    entityId: string;
    data?: JsonValue;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(
       project_id, actor_type, actor_id, action, entity_type, entity_id, data
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      params.projectId,
      params.actor.type,
      params.actor.id,
      params.action,
      params.entityType,
      params.entityId,
      JSON.stringify(params.data ?? {}),
    ],
  );
}

export class PostgresBuilderSessionStore implements BuilderSessionStore {
  public constructor(private readonly pool: Pool) {}

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async hydrateSession(
    client: PoolClient,
    builderSessionId: string,
    lock = false,
  ): Promise<Record<string, unknown> | null> {
    const result = await client.query(
      `SELECT session.*,
              row_to_json(session_plan) AS plan,
              row_to_json(evidence) AS evidence
         FROM builder_sessions session
         JOIN builder_session_plans session_plan
           ON session_plan.id = session.builder_session_plan_id
          AND session_plan.project_id = session.project_id
         LEFT JOIN builder_session_evidence evidence
           ON evidence.builder_session_id = session.id
          AND evidence.project_id = session.project_id
        WHERE session.id = $1
        ${lock ? "FOR UPDATE OF session" : ""}`,
      [builderSessionId],
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  public async prepareBuilderSession(
    input: PrepareBuilderSessionInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const existing = await client.query(
        `SELECT session.id
           FROM builder_sessions session
          WHERE session.builder_invocation_id = $1`,
        [input.builderInvocationId],
      );
      const existingId = existing.rows[0]?.id as string | undefined;
      if (existingId) {
        return (await this.hydrateSession(client, existingId)) as Record<string, unknown>;
      }

      const contextResult = await client.query<SessionPreparationRow>(
        `SELECT invocation.project_id,
                invocation.id AS builder_invocation_id,
                invocation_plan.id AS builder_invocation_plan_id,
                invocation_plan.plan_hash AS builder_plan_hash,
                invocation.execution_attempt_id,
                invocation_plan.task_context_pack_id,
                invocation_plan.task_context_pack_hash,
                workspace.id AS repository_workspace_id,
                workspace_plan.id AS repository_workspace_plan_id,
                capture_run.id AS initial_read_context_run_id,
                invocation_plan.max_turns
           FROM builder_invocations invocation
           JOIN builder_invocation_plans invocation_plan
             ON invocation_plan.id = invocation.builder_invocation_plan_id
            AND invocation_plan.project_id = invocation.project_id
           JOIN execution_attempts attempt
             ON attempt.id = invocation.execution_attempt_id
            AND attempt.project_id = invocation.project_id
           JOIN repository_workspace_plans workspace_plan
             ON workspace_plan.builder_invocation_id = invocation.id
            AND workspace_plan.project_id = invocation.project_id
           JOIN repository_workspaces workspace
             ON workspace.repository_workspace_plan_id = workspace_plan.id
            AND workspace.project_id = workspace_plan.project_id
           JOIN LATERAL (
             SELECT run.id
               FROM workspace_read_context_runs run
               JOIN workspace_read_context_requests request
                 ON request.id = run.workspace_read_context_request_id
                AND request.project_id = run.project_id
              WHERE request.project_id = invocation.project_id
                AND request.builder_invocation_id = invocation.id
                AND request.repository_workspace_id = workspace.id
                AND run.status = 'CAPTURED'
              ORDER BY run.completed_at DESC, run.created_at DESC, run.id DESC
              LIMIT 1
           ) capture_run ON true
          WHERE invocation.id = $1
            AND invocation.status = 'PREPARED'
            AND attempt.status = 'ACTIVE'
            AND attempt.lease_expires_at > now()
            AND workspace.status = 'MATERIALIZED'
          FOR UPDATE OF invocation`,
        [input.builderInvocationId],
      );
      const context = contextResult.rows[0];
      if (!context) {
        throw new Error(
          "Builder session conflict: active invocation, execution lease, workspace, and captured context are required",
        );
      }

      const planInput = {
        projectId: context.project_id,
        builderInvocationId: context.builder_invocation_id,
        builderInvocationPlanId: context.builder_invocation_plan_id,
        builderPlanHash: context.builder_plan_hash,
        executionAttemptId: context.execution_attempt_id,
        taskContextPackId: context.task_context_pack_id,
        taskContextPackHash: context.task_context_pack_hash,
        repositoryWorkspaceId: context.repository_workspace_id,
        repositoryWorkspacePlanId: context.repository_workspace_plan_id,
        initialReadContextRunId: context.initial_read_context_run_id,
        maxTurns: context.max_turns,
      } as const;
      const planContent = buildBuilderSessionPlanContent(planInput);
      const planHash = hashBuilderSessionPlan(planInput);
      const planResult = await client.query(
        `INSERT INTO builder_session_plans(
           project_id, builder_invocation_id, builder_invocation_plan_id,
           execution_attempt_id, task_context_pack_id, task_context_pack_hash,
           repository_workspace_id, repository_workspace_plan_id,
           initial_read_context_run_id, max_turns,
           plan_content, plan_hash, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11::jsonb, $12, $13
         )
         RETURNING *`,
        [
          context.project_id,
          context.builder_invocation_id,
          context.builder_invocation_plan_id,
          context.execution_attempt_id,
          context.task_context_pack_id,
          context.task_context_pack_hash,
          context.repository_workspace_id,
          context.repository_workspace_plan_id,
          context.initial_read_context_run_id,
          context.max_turns,
          JSON.stringify(planContent),
          planHash,
          input.actor.id,
        ],
      );
      const plan = planResult.rows[0] as Record<string, unknown>;
      const sessionResult = await client.query(
        `INSERT INTO builder_sessions(
           project_id, builder_session_plan_id, builder_invocation_id,
           current_read_context_run_id
         ) VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [
          context.project_id,
          plan.id,
          context.builder_invocation_id,
          context.initial_read_context_run_id,
        ],
      );
      const session = sessionResult.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action: "BUILDER_SESSION_PREPARED",
        entityType: "BUILDER_SESSION",
        entityId: String(session.id),
        data: { builderInvocationId: context.builder_invocation_id, planHash },
      });
      return { ...session, plan, evidence: null };
    });
  }

  public async acquireBuilderSessionStepClaim(
    input: AcquireBuilderSessionStepClaimInput,
  ): Promise<Record<string, unknown>> {
    assertLeaseSeconds(input.leaseSeconds, "step claim leaseSeconds");
    if (input.claimOwner.trim().length === 0) {
      throw new Error("claimOwner must not be empty");
    }
    return this.transaction(async (client) => {
      const session = await this.hydrateSession(client, input.builderSessionId, true);
      if (!session) {
        throw new Error(`Builder session not found: ${input.builderSessionId}`);
      }
      const expired = await client.query(
        `UPDATE builder_session_step_claims
            SET status = 'EXPIRED', completed_at = now()
          WHERE builder_session_id = $1
            AND status = 'ACTIVE'
            AND lease_expires_at <= now()
          RETURNING id, project_id`,
        [input.builderSessionId],
      );
      for (const row of expired.rows) {
        await appendAudit(client, {
          projectId: String(row.project_id),
          actor: input.actor,
          action: "BUILDER_SESSION_STEP_CLAIM_EXPIRED",
          entityType: "BUILDER_SESSION_STEP_CLAIM",
          entityId: String(row.id),
          data: { builderSessionId: input.builderSessionId },
        });
      }
      const active = await client.query(
        `SELECT *
           FROM builder_session_step_claims
          WHERE builder_session_id = $1
            AND status = 'ACTIVE'
            AND lease_expires_at > now()
          LIMIT 1`,
        [input.builderSessionId],
      );
      if (active.rows[0]) {
        return { acquired: false, reason: "ALREADY_CLAIMED", claim: active.rows[0], session };
      }
      const claimResult = await client.query(
        `INSERT INTO builder_session_step_claims(
           project_id, builder_session_id, claim_owner, lease_expires_at, started_state
         ) VALUES ($1, $2, $3, now() + ($4 * interval '1 second'), $5)
         RETURNING *`,
        [
          session.project_id,
          input.builderSessionId,
          input.claimOwner,
          input.leaseSeconds,
          session.status,
        ],
      );
      const claim = claimResult.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: String(session.project_id),
        actor: input.actor,
        action: "BUILDER_SESSION_STEP_CLAIM_ACQUIRED",
        entityType: "BUILDER_SESSION_STEP_CLAIM",
        entityId: String(claim.id),
        data: {
          builderSessionId: input.builderSessionId,
          claimOwner: input.claimOwner,
          startedState: session.status as JsonValue,
        },
      });
      return { acquired: true, claim, session };
    });
  }

  private async assertActiveStepClaim(
    client: PoolClient,
    builderSessionId: string,
    stepClaimId: string,
    stepClaimToken: string,
  ): Promise<Record<string, unknown>> {
    const result = await client.query(
      `SELECT claim.*
         FROM builder_session_step_claims claim
        WHERE claim.id = $1
          AND claim.builder_session_id = $2
          AND claim.claim_token = $3::uuid
          AND claim.status = 'ACTIVE'
          AND claim.lease_expires_at > now()
        FOR UPDATE`,
      [stepClaimId, builderSessionId, stepClaimToken],
    );
    const claim = result.rows[0] as Record<string, unknown> | undefined;
    if (!claim) {
      throw new Error("Builder session step claim conflict: active ownership proof is required");
    }
    return claim;
  }

  public async heartbeatBuilderSessionExecutionLease(
    input: HeartbeatBuilderSessionExecutionLeaseInput,
  ): Promise<Record<string, unknown>> {
    assertLeaseSeconds(input.leaseSeconds, "execution leaseSeconds");
    return this.transaction(async (client) => {
      await this.assertActiveStepClaim(
        client,
        input.builderSessionId,
        input.stepClaimId,
        input.stepClaimToken,
      );
      const result = await client.query(
        `UPDATE execution_attempts attempt
            SET heartbeat_at = now(),
                lease_expires_at = now() + ($4 * interval '1 second')
           FROM builder_sessions session
           JOIN builder_session_plans session_plan
             ON session_plan.id = session.builder_session_plan_id
            AND session_plan.project_id = session.project_id
          WHERE session.id = $1
            AND session.project_id = attempt.project_id
            AND attempt.id = session_plan.execution_attempt_id
            AND attempt.status = 'ACTIVE'
            AND attempt.lease_expires_at > now()
          RETURNING attempt.id, attempt.project_id, attempt.heartbeat_at, attempt.lease_expires_at`,
        [input.builderSessionId, input.stepClaimId, input.stepClaimToken, input.leaseSeconds],
      );
      const attempt = result.rows[0] as Record<string, unknown> | undefined;
      if (!attempt) {
        throw new Error(
          "Builder session execution authority conflict: execution lease is missing, expired, or inactive",
        );
      }
      return attempt;
    });
  }

  public async transitionBuilderSession(
    input: TransitionBuilderSessionInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      await this.assertActiveStepClaim(
        client,
        input.builderSessionId,
        input.stepClaimId,
        input.stepClaimToken,
      );
      const current = await this.hydrateSession(client, input.builderSessionId, true);
      if (!current) {
        throw new Error(`Builder session not found: ${input.builderSessionId}`);
      }
      if (current.status !== input.expectedStatus) {
        throw new Error(
          `Builder session conflict: expected status ${input.expectedStatus}, found ${String(current.status)}`,
        );
      }
      const nextReadContext = input.currentReadContextRunId ?? current.current_read_context_run_id;
      const nextProposal = input.currentProposalRunId === undefined
        ? current.current_proposal_run_id
        : input.currentProposalRunId;
      const nextAction = input.currentActionRunId === undefined
        ? current.current_action_run_id
        : input.currentActionRunId;
      const nextTurnCount = input.turnCount ?? current.turn_count;
      const result = await client.query(
        `UPDATE builder_sessions
            SET status = $2,
                state_version = state_version + 1,
                current_read_context_run_id = $3,
                current_proposal_run_id = $4,
                current_action_run_id = $5,
                turn_count = $6,
                started_at = CASE
                  WHEN started_at IS NULL AND $2 <> 'PREPARED' THEN now()
                  ELSE started_at
                END,
                completed_at = CASE
                  WHEN $2 IN ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED') THEN now()
                  ELSE NULL
                END,
                updated_at = now()
          WHERE id = $1
            AND status = $7
          RETURNING *`,
        [
          input.builderSessionId,
          input.nextStatus,
          nextReadContext,
          nextProposal,
          nextAction,
          nextTurnCount,
          input.expectedStatus,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error("Builder session conflict: concurrent state transition detected");
      }
      const updated = result.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: String(updated.project_id),
        actor: input.actor,
        action: "BUILDER_SESSION_TRANSITIONED",
        entityType: "BUILDER_SESSION",
        entityId: input.builderSessionId,
        data: {
          from: input.expectedStatus,
          to: input.nextStatus,
          turnCount: nextTurnCount as JsonValue,
        },
      });
      return (await this.hydrateSession(client, input.builderSessionId)) ?? updated;
    });
  }

  public async completeBuilderSessionStepClaim(
    input: CompleteBuilderSessionStepClaimInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const claimResult = await client.query(
        `SELECT claim.*, session.status AS session_status
           FROM builder_session_step_claims claim
           JOIN builder_sessions session
             ON session.id = claim.builder_session_id
            AND session.project_id = claim.project_id
          WHERE claim.id = $1
            AND claim.claim_token = $2::uuid
            AND claim.status = 'ACTIVE'
            AND claim.lease_expires_at > now()
          FOR UPDATE OF claim`,
        [input.builderSessionStepClaimId, input.claimToken],
      );
      const claim = claimResult.rows[0] as Record<string, unknown> | undefined;
      if (!claim) {
        throw new Error("Builder session step claim conflict: active claim token is required");
      }
      const result = await client.query(
        `UPDATE builder_session_step_claims
            SET status = 'COMPLETED',
                operation = $3,
                completed_state = $4,
                completed_at = now()
          WHERE id = $1
            AND claim_token = $2::uuid
          RETURNING *`,
        [
          input.builderSessionStepClaimId,
          input.claimToken,
          input.operation,
          claim.session_status,
        ],
      );
      const completed = result.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: String(completed.project_id),
        actor: input.actor,
        action: "BUILDER_SESSION_STEP_COMPLETED",
        entityType: "BUILDER_SESSION_STEP_CLAIM",
        entityId: input.builderSessionStepClaimId,
        data: { operation: input.operation, completedState: claim.session_status as JsonValue },
      });
      return completed;
    });
  }

  public async releaseBuilderSessionStepClaim(
    input: ReleaseBuilderSessionStepClaimInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE builder_session_step_claims
            SET status = 'RELEASED', completed_at = now()
          WHERE id = $1
            AND claim_token = $2::uuid
            AND status = 'ACTIVE'
          RETURNING *`,
        [input.builderSessionStepClaimId, input.claimToken],
      );
      const released = result.rows[0] as Record<string, unknown> | undefined;
      if (!released) {
        throw new Error("Builder session step claim conflict: active claim token is required");
      }
      await appendAudit(client, {
        projectId: String(released.project_id),
        actor: input.actor,
        action: "BUILDER_SESSION_STEP_RELEASED",
        entityType: "BUILDER_SESSION_STEP_CLAIM",
        entityId: input.builderSessionStepClaimId,
      });
      return released;
    });
  }

  public async recordBuilderSessionTerminalEvidence(
    input: RecordBuilderSessionTerminalEvidenceInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      await this.assertActiveStepClaim(
        client,
        input.builderSessionId,
        input.stepClaimId,
        input.stepClaimToken,
      );
      const session = await this.hydrateSession(client, input.builderSessionId, true);
      if (!session) {
        throw new Error(`Builder session not found: ${input.builderSessionId}`);
      }
      const contentInput = {
        outcome: input.outcome,
        turnCount: Number(session.turn_count),
        finalActionEvidenceId: input.finalActionEvidenceId,
        finalActionEvidenceHash: input.finalActionEvidenceHash,
        summary: input.summary,
      } as const;
      const evidenceContent = buildBuilderSessionTerminalEvidenceContent(contentInput);
      const evidenceHash = hashBuilderSessionTerminalEvidence(contentInput);
      const existingResult = await client.query(
        `SELECT * FROM builder_session_evidence WHERE builder_session_id = $1`,
        [input.builderSessionId],
      );
      let evidence = existingResult.rows[0] as Record<string, unknown> | undefined;
      if (!evidence) {
        const result = await client.query(
          `INSERT INTO builder_session_evidence(
             project_id, builder_session_id, outcome, turn_count,
             final_action_evidence_id, final_action_evidence_hash,
             summary, evidence_content, evidence_hash, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
           RETURNING *`,
          [
            session.project_id,
            input.builderSessionId,
            input.outcome,
            session.turn_count,
            input.finalActionEvidenceId,
            input.finalActionEvidenceHash,
            input.summary,
            JSON.stringify(evidenceContent),
            evidenceHash,
            input.actor.id,
          ],
        );
        evidence = result.rows[0] as Record<string, unknown>;
      } else if (evidence.evidence_hash !== evidenceHash) {
        throw new Error("Builder session conflict: terminal evidence already differs");
      }

      const terminalStatus = input.outcome as BuilderSessionStatus;
      const transitionResult = await client.query(
        `UPDATE builder_sessions
            SET status = $2,
                state_version = state_version + 1,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1
            AND status = 'WAITING_ACTION'
          RETURNING *`,
        [input.builderSessionId, terminalStatus],
      );
      if (transitionResult.rowCount !== 1) {
        throw new Error(
          "Builder session conflict: terminal session must be waiting on a satisfied terminal action",
        );
      }
      await appendAudit(client, {
        projectId: String(session.project_id),
        actor: input.actor,
        action: "BUILDER_SESSION_TERMINAL_EVIDENCE_RECORDED",
        entityType: "BUILDER_SESSION",
        entityId: input.builderSessionId,
        data: { outcome: input.outcome, evidenceHash },
      });
      return (await this.hydrateSession(client, input.builderSessionId)) ?? {
        ...transitionResult.rows[0],
        evidence,
      };
    });
  }

  public async getBuilderSession(
    builderSessionId: string,
  ): Promise<Record<string, unknown> | null> {
    const client = await this.pool.connect();
    try {
      return await this.hydrateSession(client, builderSessionId);
    } finally {
      client.release();
    }
  }

  public async getBuilderSessionStepContext(
    builderSessionId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT session.*,
              row_to_json(session_plan) AS plan,
              row_to_json(proposal_run) AS proposal_run,
              row_to_json(proposal_evidence) AS proposal_evidence,
              row_to_json(action_run) AS action_run,
              row_to_json(action_decision) AS action_decision,
              row_to_json(action_evidence) AS action_evidence
         FROM builder_sessions session
         JOIN builder_session_plans session_plan
           ON session_plan.id = session.builder_session_plan_id
          AND session_plan.project_id = session.project_id
         LEFT JOIN builder_proposal_runs proposal_run
           ON proposal_run.id = session.current_proposal_run_id
          AND proposal_run.project_id = session.project_id
         LEFT JOIN builder_proposal_evidence proposal_evidence
           ON proposal_evidence.builder_proposal_run_id = proposal_run.id
          AND proposal_evidence.project_id = proposal_run.project_id
         LEFT JOIN builder_proposal_action_runs action_run
           ON action_run.id = session.current_action_run_id
          AND action_run.project_id = session.project_id
         LEFT JOIN builder_proposal_action_decisions action_decision
           ON action_decision.id = action_run.builder_proposal_action_decision_id
          AND action_decision.project_id = action_run.project_id
         LEFT JOIN builder_proposal_action_evidence action_evidence
           ON action_evidence.builder_proposal_action_run_id = action_run.id
          AND action_evidence.project_id = action_run.project_id
        WHERE session.id = $1`,
      [builderSessionId],
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  public async getProjectBuilderSessionStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `SELECT status, count(*)::integer AS count
         FROM builder_sessions
        WHERE project_id = $1
        GROUP BY status
        ORDER BY status`,
      [projectId],
    );
    return { projectId, states: result.rows };
  }

  public async getPlatformBuilderSessionStatus(): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `SELECT status, count(*)::integer AS count
         FROM builder_sessions
        GROUP BY status
        ORDER BY status`,
    );
    return { states: result.rows };
  }
}
