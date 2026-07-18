import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  evaluateFreshness,
  type FreshnessFacts,
} from "../domain/freshness-validation.js";
import type { JsonValue } from "../domain/stable-json.js";
import type { WorkQueueStatus } from "../domain/work-queue.js";
import type { Actor } from "./types.js";
import type {
  FreshnessValidationStore,
  ValidateWorkQueueItemInput,
} from "./freshness-validation-types.js";

interface ValidationContextRow extends QueryResultRow {
  readonly work_queue_item_id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly work_status: WorkQueueStatus;
  readonly state_version: number;
  readonly waiting_reason:
    | "NONE"
    | "QUOTA"
    | "BUDGET"
    | "DEPENDENCY"
    | "FOUNDER_DECISION"
    | "EXTERNAL_SYSTEM"
    | "PROVIDER_UNAVAILABLE"
    | "POLICY";
  readonly project_status: FreshnessFacts["projectStatus"];
  readonly task_status: FreshnessFacts["taskStatus"];
  readonly change_contract_id: string;
  readonly change_contract_version_id: string;
  readonly change_contract_version: number;
  readonly contract_content_hash: string;
  readonly contract_status: FreshnessFacts["contractStatus"];
  readonly current_contract_version: number;
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

export class PostgresFreshnessValidationStore
  implements FreshnessValidationStore
{
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

  public async validateWorkQueueItem(
    input: ValidateWorkQueueItemInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const contextResult = await client.query<ValidationContextRow>(
        `SELECT
           w.id AS work_queue_item_id,
           w.project_id,
           w.task_id,
           w.status AS work_status,
           w.state_version,
           w.waiting_reason,
           p.status AS project_status,
           t.status AS task_status,
           c.id AS change_contract_id,
           v.id AS change_contract_version_id,
           v.version AS change_contract_version,
           v.content_hash AS contract_content_hash,
           c.status AS contract_status,
           c.current_version AS current_contract_version
         FROM work_queue_items w
         JOIN projects p ON p.id = w.project_id
         JOIN tasks t ON t.id = w.task_id AND t.project_id = w.project_id
         JOIN change_contract_versions v
           ON v.id = t.change_contract_version_id
          AND v.project_id = w.project_id
         JOIN change_contracts c
           ON c.id = v.contract_id
          AND c.project_id = w.project_id
         WHERE w.id = $1
         FOR UPDATE OF w`,
        [input.workQueueItemId],
      );

      const context = contextResult.rows[0];
      if (!context) {
        throw new Error(`Work queue item not found: ${input.workQueueItemId}`);
      }

      if (!["QUEUED", "ELIGIBLE", "BLOCKED"].includes(context.work_status)) {
        throw new Error(
          `Work validation conflict: status ${context.work_status} cannot be validated`,
        );
      }

      const decision = evaluateFreshness({
        projectStatus: context.project_status,
        taskStatus: context.task_status,
        contractStatus: context.contract_status,
        contractVersion: context.change_contract_version,
        currentContractVersion: context.current_contract_version,
      });

      const shouldChangeQueue =
        context.work_status !== decision.targetStatus ||
        context.waiting_reason !== decision.waitingReason;

      let resultingStateVersion = context.state_version;
      let workItem: Record<string, unknown>;

      if (shouldChangeQueue) {
        const workItemResult = await client.query(
          `UPDATE work_queue_items
              SET status = $2,
                  waiting_reason = $3,
                  state_version = state_version + 1,
                  updated_at = now()
            WHERE id = $1
            RETURNING *`,
          [
            input.workQueueItemId,
            decision.targetStatus,
            decision.waitingReason,
          ],
        );
        workItem = workItemResult.rows[0] as Record<string, unknown>;
        resultingStateVersion = Number(workItem.state_version);
      } else {
        const workItemResult = await client.query(
          `SELECT * FROM work_queue_items WHERE id = $1`,
          [input.workQueueItemId],
        );
        workItem = workItemResult.rows[0] as Record<string, unknown>;
      }

      const checks = {
        projectStatus: context.project_status,
        taskStatus: context.task_status,
        contractStatus: context.contract_status,
        contractVersion: context.change_contract_version,
        currentContractVersion: context.current_contract_version,
      } as const;

      const validationResult = await client.query(
        `INSERT INTO work_validation_runs(
          work_queue_item_id,
          project_id,
          queue_state_version,
          task_id,
          change_contract_id,
          change_contract_version_id,
          change_contract_version,
          contract_content_hash,
          outcome,
          reason_code,
          checks,
          created_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12
        )
        RETURNING *`,
        [
          context.work_queue_item_id,
          context.project_id,
          resultingStateVersion,
          context.task_id,
          context.change_contract_id,
          context.change_contract_version_id,
          context.change_contract_version,
          context.contract_content_hash,
          decision.outcome,
          decision.reasonCode,
          JSON.stringify(checks),
          input.actor.id,
        ],
      );

      const validation = validationResult.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action: "WORK_FRESHNESS_VALIDATED",
        entityType: "WORK_VALIDATION_RUN",
        entityId: String(validation.id),
        data: {
          workQueueItemId: context.work_queue_item_id,
          queueStateVersion: resultingStateVersion,
          outcome: decision.outcome,
          reasonCode: decision.reasonCode,
          changeContractVersionId: context.change_contract_version_id,
          contractContentHash: context.contract_content_hash,
        },
      });

      return { workItem, validation };
    });
  }

  public async getProjectValidationStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [counts, recent] = await Promise.all([
      this.pool.query(
        `SELECT outcome, count(*)::text AS count
           FROM work_validation_runs
          WHERE project_id = $1
          GROUP BY outcome
          ORDER BY outcome`,
        [projectId],
      ),
      this.pool.query(
        `SELECT *
           FROM work_validation_runs
          WHERE project_id = $1
          ORDER BY created_at DESC
          LIMIT 20`,
        [projectId],
      ),
    ]);

    return {
      validationCounts: counts.rows,
      recentValidationRuns: recent.rows,
    };
  }

  public async getPlatformValidationStatus(): Promise<Record<string, unknown>> {
    const counts = await this.pool.query(
      `SELECT outcome, count(*)::text AS count
         FROM work_validation_runs
        GROUP BY outcome
        ORDER BY outcome`,
    );

    return { validationCounts: counts.rows };
  }
}
