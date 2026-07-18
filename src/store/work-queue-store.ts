import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  canChangeEligibility,
  targetEligibilityState,
  type WorkQueueStatus,
} from "../domain/work-queue.js";
import type { JsonValue } from "../domain/stable-json.js";
import type { Actor } from "./types.js";
import type {
  ClaimExecutionLeaseInput,
  CompleteExecutionLeaseInput,
  CreateWorkQueueItemInput,
  HeartbeatExecutionLeaseInput,
  ReleaseExecutionLeaseInput,
  SetWorkQueueEligibilityInput,
  WorkQueueStore,
} from "./work-queue-types.js";

interface WorkQueueRow extends QueryResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly status: WorkQueueStatus;
  readonly state_version: number;
  readonly idempotency_key: string;
}

interface ExecutionAttemptRow extends QueryResultRow {
  readonly id: string;
  readonly work_queue_item_id: string;
  readonly project_id: string;
  readonly lease_token: string;
  readonly lease_expires_at: Date;
}

async function appendAudit(
  client: PoolClient,
  params: {
    projectId: string | null;
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

export class PostgresWorkQueueStore implements WorkQueueStore {
  public constructor(private readonly pool: Pool) {}

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
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

  public async createWorkQueueItem(
    input: CreateWorkQueueItemInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO work_queue_items(
          project_id, task_id, priority, execution_policy, scheduled_for, idempotency_key
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [
          input.projectId,
          input.taskId,
          input.priority,
          input.executionPolicy,
          input.scheduledFor,
          input.idempotencyKey,
        ],
      );

      const workItem = result.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: input.projectId,
        actor: input.actor,
        action: "WORK_QUEUE_ITEM_CREATED",
        entityType: "WORK_QUEUE_ITEM",
        entityId: String(workItem.id),
        data: {
          taskId: input.taskId,
          priority: input.priority,
          executionPolicy: input.executionPolicy,
          idempotencyKey: input.idempotencyKey,
        },
      });

      return workItem;
    });
  }

  public async setWorkQueueEligibility(
    input: SetWorkQueueEligibilityInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const currentResult = await client.query<WorkQueueRow>(
        `SELECT id, project_id, task_id, status, state_version, idempotency_key
           FROM work_queue_items
          WHERE id = $1
          FOR UPDATE`,
        [input.workQueueItemId],
      );

      const current = currentResult.rows[0];
      if (!current) {
        throw new Error(`Work queue item not found: ${input.workQueueItemId}`);
      }
      if (current.state_version !== input.expectedStateVersion) {
        throw new Error(
          `Work queue state version conflict: expected ${input.expectedStateVersion}, current ${current.state_version}`,
        );
      }
      if (!canChangeEligibility(current.status)) {
        throw new Error(
          `Work queue eligibility conflict: status ${current.status} cannot be reclassified`,
        );
      }

      const target = targetEligibilityState(input.eligible, input.waitingReason);
      const updateResult = await client.query(
        `UPDATE work_queue_items
            SET status = $2,
                waiting_reason = $3,
                state_version = state_version + 1,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [input.workQueueItemId, target.status, target.waitingReason],
      );

      await appendAudit(client, {
        projectId: current.project_id,
        actor: input.actor,
        action: "WORK_QUEUE_ELIGIBILITY_CHANGED",
        entityType: "WORK_QUEUE_ITEM",
        entityId: input.workQueueItemId,
        data: {
          from: current.status,
          to: target.status,
          waitingReason: target.waitingReason,
          previousStateVersion: current.state_version,
        },
      });

      return updateResult.rows[0] as Record<string, unknown>;
    });
  }

  public async claimExecutionLease(
    input: ClaimExecutionLeaseInput,
  ): Promise<Record<string, unknown> | null> {
    return this.transaction(async (client) => {
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
        `SELECT id, project_id, task_id, status, state_version, idempotency_key
           FROM work_queue_items
          WHERE status = 'ELIGIBLE'
            AND ($1::uuid IS NULL OR project_id = $1::uuid)
            AND (scheduled_for IS NULL OR scheduled_for <= now())
          ORDER BY
            CASE priority
              WHEN 'P0' THEN 0
              WHEN 'P1' THEN 1
              WHEN 'P2' THEN 2
              ELSE 3
            END,
            created_at,
            id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [input.projectId],
      );

      const candidate = candidateResult.rows[0];
      if (!candidate) {
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

      return {
        workItem: itemResult.rows[0] as Record<string, unknown>,
        executionAttempt: attempt,
      };
    });
  }

  public async heartbeatExecutionLease(
    input: HeartbeatExecutionLeaseInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const currentResult = await client.query<ExecutionAttemptRow>(
        `SELECT id, work_queue_item_id, project_id, lease_token, lease_expires_at
           FROM execution_attempts
          WHERE id = $1
            AND lease_token = $2::uuid
            AND status = 'ACTIVE'
            AND lease_expires_at > now()
          FOR UPDATE`,
        [input.executionAttemptId, input.leaseToken],
      );
      const current = currentResult.rows[0];
      if (!current) {
        throw new Error(
          "Execution lease conflict: lease is missing, expired, or no longer active",
        );
      }

      const result = await client.query(
        `UPDATE execution_attempts
            SET heartbeat_at = now(),
                lease_expires_at = now() + ($3 * interval '1 second')
          WHERE id = $1
            AND lease_token = $2::uuid
          RETURNING *`,
        [input.executionAttemptId, input.leaseToken, input.leaseSeconds],
      );
      return result.rows[0] as Record<string, unknown>;
    });
  }

  public async completeExecutionLease(
    input: CompleteExecutionLeaseInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const currentResult = await client.query<ExecutionAttemptRow>(
        `SELECT id, work_queue_item_id, project_id, lease_token, lease_expires_at
           FROM execution_attempts
          WHERE id = $1
            AND lease_token = $2::uuid
            AND status = 'ACTIVE'
            AND lease_expires_at > now()
          FOR UPDATE`,
        [input.executionAttemptId, input.leaseToken],
      );
      const current = currentResult.rows[0];
      if (!current) {
        throw new Error(
          "Execution lease conflict: lease is missing, expired, or no longer active",
        );
      }

      const resultJson = input.outcome === "SUCCEEDED" ? input.details : {};
      const errorJson = input.outcome === "FAILED" ? input.details : {};
      const attemptResult = await client.query(
        `UPDATE execution_attempts
            SET status = $3,
                completed_at = now(),
                result = $4::jsonb,
                error = $5::jsonb
          WHERE id = $1
            AND lease_token = $2::uuid
          RETURNING *`,
        [
          input.executionAttemptId,
          input.leaseToken,
          input.outcome,
          JSON.stringify(resultJson),
          JSON.stringify(errorJson),
        ],
      );

      const itemStatus = input.outcome === "SUCCEEDED" ? "COMPLETED" : "FAILED";
      const itemResult = await client.query(
        `UPDATE work_queue_items
            SET status = $2,
                waiting_reason = 'NONE',
                state_version = state_version + 1,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [current.work_queue_item_id, itemStatus],
      );

      await appendAudit(client, {
        projectId: current.project_id,
        actor: input.actor,
        action:
          input.outcome === "SUCCEEDED"
            ? "EXECUTION_ATTEMPT_SUCCEEDED"
            : "EXECUTION_ATTEMPT_FAILED",
        entityType: "EXECUTION_ATTEMPT",
        entityId: input.executionAttemptId,
        data: { workQueueItemId: current.work_queue_item_id },
      });

      return {
        workItem: itemResult.rows[0] as Record<string, unknown>,
        executionAttempt: attemptResult.rows[0] as Record<string, unknown>,
      };
    });
  }

  public async releaseExecutionLease(
    input: ReleaseExecutionLeaseInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const currentResult = await client.query<ExecutionAttemptRow>(
        `SELECT id, work_queue_item_id, project_id, lease_token, lease_expires_at
           FROM execution_attempts
          WHERE id = $1
            AND lease_token = $2::uuid
            AND status = 'ACTIVE'
            AND lease_expires_at > now()
          FOR UPDATE`,
        [input.executionAttemptId, input.leaseToken],
      );
      const current = currentResult.rows[0];
      if (!current) {
        throw new Error(
          "Execution lease conflict: lease is missing, expired, or no longer active",
        );
      }

      const targetStatus = input.waitingReason === "NONE" ? "ELIGIBLE" : "BLOCKED";
      const attemptResult = await client.query(
        `UPDATE execution_attempts
            SET status = 'RELEASED', completed_at = now()
          WHERE id = $1
            AND lease_token = $2::uuid
          RETURNING *`,
        [input.executionAttemptId, input.leaseToken],
      );
      const itemResult = await client.query(
        `UPDATE work_queue_items
            SET status = $2,
                waiting_reason = $3,
                state_version = state_version + 1,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [current.work_queue_item_id, targetStatus, input.waitingReason],
      );

      await appendAudit(client, {
        projectId: current.project_id,
        actor: input.actor,
        action: "EXECUTION_LEASE_RELEASED",
        entityType: "EXECUTION_ATTEMPT",
        entityId: input.executionAttemptId,
        data: {
          workQueueItemId: current.work_queue_item_id,
          waitingReason: input.waitingReason,
          targetStatus,
        },
      });

      return {
        workItem: itemResult.rows[0] as Record<string, unknown>,
        executionAttempt: attemptResult.rows[0] as Record<string, unknown>,
      };
    });
  }

  public async getProjectQueueStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [counts, recent] = await Promise.all([
      this.pool.query(
        `SELECT
          (SELECT count(*) FROM work_queue_items WHERE project_id = $1)::text AS work_queue_items,
          (SELECT count(*) FROM execution_attempts WHERE project_id = $1 AND status = 'ACTIVE')::text AS active_execution_leases`,
        [projectId],
      ),
      this.pool.query(
        `SELECT *
           FROM work_queue_items
          WHERE project_id = $1
          ORDER BY created_at DESC
          LIMIT 20`,
        [projectId],
      ),
    ]);

    return {
      queueCounts: counts.rows[0] ?? {},
      recentWorkQueueItems: recent.rows,
    };
  }

  public async getPlatformQueueStatus(): Promise<Record<string, unknown>> {
    const [queueCounts, activeLeases] = await Promise.all([
      this.pool.query(
        `SELECT status, count(*)::text AS count
           FROM work_queue_items
          GROUP BY status
          ORDER BY status`,
      ),
      this.pool.query(
        `SELECT count(*)::text AS count
           FROM execution_attempts
          WHERE status = 'ACTIVE'`,
      ),
    ]);

    return {
      workQueueCounts: queueCounts.rows,
      activeExecutionLeases: activeLeases.rows[0]?.count ?? "0",
    };
  }
}
