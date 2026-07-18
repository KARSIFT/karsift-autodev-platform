import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { JsonValue } from "../domain/stable-json.js";
import type { Actor } from "./types.js";
import type { ClaimExecutionLeaseInput } from "./work-queue-types.js";

interface WorkQueueRow extends QueryResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly state_version: number;
  readonly idempotency_key: string;
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

export class PostgresBudgetAwareLeaseStore {
  public constructor(private readonly pool: Pool) {}

  public async claimExecutionLease(
    input: ClaimExecutionLeaseInput,
  ): Promise<Record<string, unknown> | null> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const expiredResult = await client.query<{
        id: string;
        work_queue_item_id: string;
        project_id: string;
      }>(
        `UPDATE execution_attempts
            SET status = 'EXPIRED', completed_at = now()
          WHERE status = 'ACTIVE'
            AND lease_expires_at <= now()
          RETURNING id, work_queue_item_id, project_id`,
      );

      for (const expired of expiredResult.rows) {
        await client.query(
          `UPDATE work_queue_items
              SET status = 'ELIGIBLE',
                  waiting_reason = 'NONE',
                  state_version = state_version + 1,
                  updated_at = now()
            WHERE id = $1
              AND status IN ('DISPATCHED', 'RUNNING')`,
          [expired.work_queue_item_id],
        );
        await appendAudit(client, {
          projectId: expired.project_id,
          actor: input.actor,
          action: "EXECUTION_LEASE_EXPIRED",
          entityType: "EXECUTION_ATTEMPT",
          entityId: expired.id,
          data: { workQueueItemId: expired.work_queue_item_id },
        });
      }

      const candidateResult = await client.query<WorkQueueRow>(
        `SELECT
           w.id,
           w.project_id,
           w.task_id,
           w.state_version,
           w.idempotency_key
         FROM work_queue_items w
         JOIN projects p ON p.id = w.project_id
         JOIN tasks t ON t.id = w.task_id AND t.project_id = w.project_id
         JOIN change_contract_versions cv
           ON cv.id = t.change_contract_version_id
          AND cv.project_id = w.project_id
         JOIN change_contracts c
           ON c.id = cv.contract_id
          AND c.project_id = w.project_id
         JOIN LATERAL (
           SELECT budget_decision.id,
                  budget_decision.execution_class,
                  budget_decision.decision
             FROM ai_budget_decisions budget_decision
            WHERE budget_decision.work_queue_item_id = w.id
              AND budget_decision.project_id = w.project_id
              AND budget_decision.queue_state_version = w.state_version
            ORDER BY budget_decision.created_at DESC, budget_decision.id DESC
            LIMIT 1
         ) latest_budget ON latest_budget.decision = 'APPROVED'
         WHERE w.status = 'ELIGIBLE'
           AND ($1::uuid IS NULL OR w.project_id = $1::uuid)
           AND (w.scheduled_for IS NULL OR w.scheduled_for <= now())
           AND p.status = 'ACTIVE'
           AND t.status IN ('QUEUED', 'BLOCKED', 'READY')
           AND c.status NOT IN ('SUPERSEDED', 'CANCELLED')
           AND cv.version = c.current_version
           AND has_effective_change_contract_authorization(cv.id, cv.content_hash)
           AND EXISTS (
             SELECT 1
               FROM work_validation_runs validation
              WHERE validation.work_queue_item_id = w.id
                AND validation.project_id = w.project_id
                AND validation.queue_state_version = w.state_version
                AND validation.change_contract_version_id = cv.id
                AND validation.contract_content_hash = cv.content_hash
                AND validation.outcome = 'VALID'
           )
           AND (
             latest_budget.execution_class = 'DETERMINISTIC'
             OR (
               is_effective_capability_enabled(w.project_id, 'AI_DISPATCH')
               AND EXISTS (
                 SELECT 1
                   FROM ai_budget_reservations reservation
                  WHERE reservation.budget_decision_id = latest_budget.id
                    AND reservation.project_id = w.project_id
                    AND reservation.work_queue_item_id = w.id
                    AND reservation.queue_state_version = w.state_version
                    AND reservation.status = 'RESERVED'
               )
             )
           )
         ORDER BY
           CASE w.priority
             WHEN 'P0' THEN 0
             WHEN 'P1' THEN 1
             WHEN 'P2' THEN 2
             ELSE 3
           END,
           w.created_at,
           w.id
         FOR UPDATE OF w SKIP LOCKED
         LIMIT 1`,
        [input.projectId],
      );

      const candidate = candidateResult.rows[0];
      if (!candidate) {
        await client.query("COMMIT");
        return null;
      }

      const attemptNumberResult = await client.query<{ next_attempt: number }>(
        `SELECT (COALESCE(max(attempt_number), 0) + 1)::integer AS next_attempt
           FROM execution_attempts
          WHERE work_queue_item_id = $1`,
        [candidate.id],
      );
      const attemptNumber = attemptNumberResult.rows[0]?.next_attempt ?? 1;

      const attemptResult = await client.query(
        `INSERT INTO execution_attempts(
          work_queue_item_id,
          project_id,
          attempt_number,
          idempotency_key,
          lease_owner,
          lease_expires_at
        ) VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 second'))
        RETURNING *`,
        [
          candidate.id,
          candidate.project_id,
          attemptNumber,
          candidate.idempotency_key,
          input.leaseOwner,
          input.leaseSeconds,
        ],
      );

      const itemResult = await client.query(
        `UPDATE work_queue_items
            SET status = 'RUNNING',
                waiting_reason = 'NONE',
                state_version = state_version + 1,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [candidate.id],
      );

      const attempt = attemptResult.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: candidate.project_id,
        actor: input.actor,
        action: "EXECUTION_LEASE_CLAIMED",
        entityType: "EXECUTION_ATTEMPT",
        entityId: String(attempt.id),
        data: {
          workQueueItemId: candidate.id,
          leaseOwner: input.leaseOwner,
          attemptNumber,
          idempotencyKey: candidate.idempotency_key,
        },
      });

      await client.query("COMMIT");
      return {
        workItem: itemResult.rows[0] as Record<string, unknown>,
        executionAttempt: attempt,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
