import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  evaluateAiBudget,
  type AiBudgetPolicyFacts,
  type ExecutionClass,
} from "../domain/ai-budget.js";
import type { JsonValue } from "../domain/stable-json.js";
import type {
  AiBudgetStore,
  AuthorizeWorkBudgetInput,
  SettleAiBudgetReservationInput,
  UpsertAiBudgetPolicyInput,
} from "./ai-budget-types.js";
import type { Actor } from "./types.js";

interface WorkBudgetContextRow extends QueryResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly status: string;
  readonly state_version: number;
  readonly freshness_valid: boolean;
}

interface BudgetPolicyRow extends QueryResultRow {
  readonly project_id: string;
  readonly monthly_limit_microusd: string;
  readonly per_work_limit_microusd: string;
  readonly max_ai_tier: number;
  readonly enabled: boolean;
}

interface ReservationSettlementRow extends QueryResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly work_queue_item_id: string;
  readonly reserved_microusd: string;
  readonly status: string;
}

function assertMicrousd(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
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

export class PostgresAiBudgetStore implements AiBudgetStore {
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

  public async upsertAiBudgetPolicy(
    input: UpsertAiBudgetPolicyInput,
  ): Promise<Record<string, unknown>> {
    assertMicrousd(input.monthlyLimitMicrousd, "monthlyLimitMicrousd");
    assertMicrousd(input.perWorkLimitMicrousd, "perWorkLimitMicrousd");
    if (input.perWorkLimitMicrousd > input.monthlyLimitMicrousd) {
      throw new Error("perWorkLimitMicrousd cannot exceed monthlyLimitMicrousd");
    }

    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO ai_budget_policies(
           project_id,
           monthly_limit_microusd,
           per_work_limit_microusd,
           max_ai_tier,
           enabled,
           updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (project_id) DO UPDATE
             SET monthly_limit_microusd = EXCLUDED.monthly_limit_microusd,
                 per_work_limit_microusd = EXCLUDED.per_work_limit_microusd,
                 max_ai_tier = EXCLUDED.max_ai_tier,
                 enabled = EXCLUDED.enabled,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = now()
         RETURNING *`,
        [
          input.projectId,
          input.monthlyLimitMicrousd,
          input.perWorkLimitMicrousd,
          input.maxAiTier,
          input.enabled,
          input.actor.id,
        ],
      );

      const policy = result.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: input.projectId,
        actor: input.actor,
        action: "AI_BUDGET_POLICY_UPSERTED",
        entityType: "AI_BUDGET_POLICY",
        entityId: input.projectId,
        data: {
          monthlyLimitMicrousd: input.monthlyLimitMicrousd,
          perWorkLimitMicrousd: input.perWorkLimitMicrousd,
          maxAiTier: input.maxAiTier,
          enabled: input.enabled,
        },
      });

      return policy;
    });
  }

  public async authorizeWorkBudget(
    input: AuthorizeWorkBudgetInput,
  ): Promise<Record<string, unknown>> {
    assertMicrousd(input.estimatedMaxCostMicrousd, "estimatedMaxCostMicrousd");

    return this.transaction(async (client) => {
      const workResult = await client.query<WorkBudgetContextRow>(
        `SELECT
           w.id,
           w.project_id,
           w.status,
           w.state_version,
           EXISTS (
             SELECT 1
               FROM work_validation_runs validation
              WHERE validation.work_queue_item_id = w.id
                AND validation.project_id = w.project_id
                AND validation.queue_state_version = w.state_version
                AND validation.outcome = 'VALID'
           ) AS freshness_valid
         FROM work_queue_items w
         WHERE w.id = $1
         FOR UPDATE`,
        [input.workQueueItemId],
      );

      const work = workResult.rows[0];
      if (!work) {
        throw new Error(`Work queue item not found: ${input.workQueueItemId}`);
      }
      if (work.status !== "ELIGIBLE") {
        throw new Error(
          `AI budget authorization conflict: work status ${work.status} is not ELIGIBLE`,
        );
      }
      if (!work.freshness_valid) {
        throw new Error(
          "AI budget authorization conflict: current queue state has no VALID freshness evidence",
        );
      }

      const liveCommitted = await client.query(
        `SELECT 1
           FROM ai_budget_reservations
          WHERE work_queue_item_id = $1
            AND status = 'COMMITTED'
          LIMIT 1`,
        [work.id],
      );
      if ((liveCommitted.rowCount ?? 0) > 0) {
        throw new Error(
          "AI budget authorization conflict: work item already has a committed reservation",
        );
      }

      await client.query(
        `UPDATE ai_budget_reservations
            SET status = 'RELEASED', released_at = now()
          WHERE work_queue_item_id = $1
            AND status = 'RESERVED'`,
        [work.id],
      );

      const periodResult = await client.query<{ period_start: string }>(
        `SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date::text AS period_start`,
      );
      const periodStart = periodResult.rows[0]?.period_start;
      if (!periodStart) {
        throw new Error("Failed to resolve AI budget period");
      }

      let policy: AiBudgetPolicyFacts | null = null;
      let policyRow: BudgetPolicyRow | null = null;
      let committedAndReservedMicrousd = 0;

      if (input.executionClass !== "DETERMINISTIC") {
        const policyResult = await client.query<BudgetPolicyRow>(
          `SELECT *
             FROM ai_budget_policies
            WHERE project_id = $1
            FOR UPDATE`,
          [work.project_id],
        );
        policyRow = policyResult.rows[0] ?? null;

        if (policyRow) {
          policy = {
            enabled: policyRow.enabled,
            monthlyLimitMicrousd: Number(policyRow.monthly_limit_microusd),
            perWorkLimitMicrousd: Number(policyRow.per_work_limit_microusd),
            maxAiTier: policyRow.max_ai_tier as 0 | 1 | 2 | 3 | 4,
          };

          const usageResult = await client.query<{ consumed_microusd: string }>(
            `SELECT COALESCE(sum(
               CASE
                 WHEN status IN ('RESERVED', 'COMMITTED') THEN reserved_microusd
                 WHEN status = 'SETTLED' THEN actual_cost_microusd
                 ELSE 0
               END
             ), 0)::text AS consumed_microusd
               FROM ai_budget_reservations
              WHERE project_id = $1
                AND period_start = $2::date`,
            [work.project_id, periodStart],
          );
          committedAndReservedMicrousd = Number(
            usageResult.rows[0]?.consumed_microusd ?? "0",
          );
        }
      }

      const evaluation = evaluateAiBudget({
        executionClass: input.executionClass,
        estimatedMaxCostMicrousd: input.estimatedMaxCostMicrousd,
        policy,
        committedAndReservedMicrousd,
      });

      const decisionResult = await client.query(
        `INSERT INTO ai_budget_decisions(
           project_id,
           work_queue_item_id,
           queue_state_version,
           execution_class,
           estimated_max_cost_microusd,
           decision,
           reason_code,
           period_start,
           policy_monthly_limit_microusd,
           policy_per_work_limit_microusd,
           policy_max_ai_tier,
           committed_and_reserved_microusd,
           actor_type,
           actor_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12, $13, $14
         )
         RETURNING *`,
        [
          work.project_id,
          work.id,
          work.state_version,
          input.executionClass,
          input.estimatedMaxCostMicrousd,
          evaluation.outcome,
          evaluation.reason,
          periodStart,
          policyRow?.monthly_limit_microusd ?? null,
          policyRow?.per_work_limit_microusd ?? null,
          policyRow?.max_ai_tier ?? null,
          committedAndReservedMicrousd,
          input.actor.type,
          input.actor.id,
        ],
      );
      const decision = decisionResult.rows[0] as Record<string, unknown>;

      let reservation: Record<string, unknown> | null = null;
      if (
        evaluation.outcome === "APPROVED" &&
        input.executionClass !== "DETERMINISTIC"
      ) {
        const reservationResult = await client.query(
          `INSERT INTO ai_budget_reservations(
             budget_decision_id,
             project_id,
             work_queue_item_id,
             queue_state_version,
             period_start,
             reserved_microusd
           ) VALUES ($1, $2, $3, $4, $5::date, $6)
           RETURNING *`,
          [
            decision.id,
            work.project_id,
            work.id,
            work.state_version,
            periodStart,
            evaluation.reservationMicrousd,
          ],
        );
        reservation = reservationResult.rows[0] as Record<string, unknown>;
      }

      await appendAudit(client, {
        projectId: work.project_id,
        actor: input.actor,
        action: `AI_BUDGET_${evaluation.outcome}`,
        entityType: "AI_BUDGET_DECISION",
        entityId: String(decision.id),
        data: {
          workQueueItemId: work.id,
          queueStateVersion: work.state_version,
          executionClass: input.executionClass,
          estimatedMaxCostMicrousd: input.estimatedMaxCostMicrousd,
          outcome: evaluation.outcome,
          reason: evaluation.reason,
          reservationMicrousd: evaluation.reservationMicrousd,
        },
      });

      return { decision, reservation };
    });
  }

  public async settleAiBudgetReservation(
    input: SettleAiBudgetReservationInput,
  ): Promise<Record<string, unknown>> {
    assertMicrousd(input.actualCostMicrousd, "actualCostMicrousd");

    return this.transaction(async (client) => {
      const reservationResult = await client.query<ReservationSettlementRow>(
        `SELECT reservation.*
           FROM ai_budget_reservations reservation
          WHERE reservation.execution_attempt_id = $1
          FOR UPDATE`,
        [input.executionAttemptId],
      );
      const reservation = reservationResult.rows[0];
      if (!reservation) {
        throw new Error(
          `AI budget reservation not found for execution attempt: ${input.executionAttemptId}`,
        );
      }
      if (reservation.status !== "COMMITTED") {
        throw new Error(
          `AI budget settlement conflict: reservation status ${reservation.status} is not COMMITTED`,
        );
      }

      const reservedMicrousd = Number(reservation.reserved_microusd);
      if (input.actualCostMicrousd > reservedMicrousd) {
        throw new Error(
          `AI budget settlement conflict: actual cost ${input.actualCostMicrousd} exceeds reserved ${reservedMicrousd}`,
        );
      }

      const settledResult = await client.query(
        `UPDATE ai_budget_reservations
            SET status = 'SETTLED',
                actual_cost_microusd = $2,
                settled_at = now()
          WHERE id = $1
          RETURNING *`,
        [reservation.id, input.actualCostMicrousd],
      );
      const settled = settledResult.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: reservation.project_id,
        actor: input.actor,
        action: "AI_BUDGET_RESERVATION_SETTLED",
        entityType: "AI_BUDGET_RESERVATION",
        entityId: reservation.id,
        data: {
          executionAttemptId: input.executionAttemptId,
          reservedMicrousd,
          actualCostMicrousd: input.actualCostMicrousd,
        },
      });

      return settled;
    });
  }

  public async getProjectAiBudgetStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [policy, usage, decisions, reservations] = await Promise.all([
      this.pool.query(`SELECT * FROM ai_budget_policies WHERE project_id = $1`, [projectId]),
      this.pool.query(
        `SELECT COALESCE(sum(
           CASE
             WHEN status IN ('RESERVED', 'COMMITTED') THEN reserved_microusd
             WHEN status = 'SETTLED' THEN actual_cost_microusd
             ELSE 0
           END
         ), 0)::text AS current_period_consumed_microusd
           FROM ai_budget_reservations
          WHERE project_id = $1
            AND period_start = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
        [projectId],
      ),
      this.pool.query(
        `SELECT * FROM ai_budget_decisions
          WHERE project_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 20`,
        [projectId],
      ),
      this.pool.query(
        `SELECT * FROM ai_budget_reservations
          WHERE project_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 20`,
        [projectId],
      ),
    ]);

    return {
      aiBudgetPolicy: policy.rows[0] ?? null,
      aiBudgetUsage: usage.rows[0] ?? { current_period_consumed_microusd: "0" },
      recentAiBudgetDecisions: decisions.rows,
      recentAiBudgetReservations: reservations.rows,
    };
  }

  public async getPlatformAiBudgetStatus(): Promise<Record<string, unknown>> {
    const [policies, usage] = await Promise.all([
      this.pool.query(`SELECT count(*)::text AS policy_count FROM ai_budget_policies`),
      this.pool.query(
        `SELECT COALESCE(sum(
           CASE
             WHEN status IN ('RESERVED', 'COMMITTED') THEN reserved_microusd
             WHEN status = 'SETTLED' THEN actual_cost_microusd
             ELSE 0
           END
         ), 0)::text AS current_period_consumed_microusd
           FROM ai_budget_reservations
          WHERE period_start = date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
      ),
    ]);

    return {
      aiBudgetPolicyCount: policies.rows[0]?.policy_count ?? "0",
      aiBudgetCurrentPeriodConsumedMicrousd:
        usage.rows[0]?.current_period_consumed_microusd ?? "0",
    };
  }
}
