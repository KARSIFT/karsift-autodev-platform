import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  assertProviderKey,
  evaluateProviderDispatchReadiness,
} from "../domain/provider-capacity.js";
import type { JsonValue } from "../domain/stable-json.js";
import type {
  EvaluateProviderDispatchInput,
  ProviderDispatchStore,
  RecordProviderCapacityObservationInput,
} from "./provider-dispatch-types.js";
import type { Actor } from "./types.js";

interface DispatchWorkRow extends QueryResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly status: string;
  readonly state_version: number;
  readonly ai_budget_decision_id: string;
  readonly execution_class: string;
}

interface CapacityObservationRow extends QueryResultRow {
  readonly id: string;
  readonly status: "HEALTHY" | "DEGRADED" | "QUOTA_EXHAUSTED" | "UNAVAILABLE";
  readonly fresh: boolean;
}

function assertTtlSeconds(ttlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 3600) {
    throw new Error("ttlSeconds must be a safe integer between 30 and 3600");
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

export class PostgresProviderDispatchStore implements ProviderDispatchStore {
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

  public async recordProviderCapacityObservation(
    input: RecordProviderCapacityObservationInput,
  ): Promise<Record<string, unknown>> {
    assertProviderKey(input.providerKey);
    assertTtlSeconds(input.ttlSeconds);

    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO ai_provider_capacity_observations(
           project_id,
           provider_key,
           capability,
           status,
           quota_reset_at,
           details,
           observed_by,
           expires_at
         ) VALUES (
           $1, $2, $3, $4, $5::timestamptz, $6::jsonb, $7,
           now() + ($8 * interval '1 second')
         )
         RETURNING *`,
        [
          input.projectId,
          input.providerKey,
          input.capability,
          input.status,
          input.quotaResetAt,
          JSON.stringify(input.details),
          input.actor.id,
          input.ttlSeconds,
        ],
      );
      const observation = result.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: input.projectId,
        actor: input.actor,
        action: "AI_PROVIDER_CAPACITY_OBSERVED",
        entityType: "AI_PROVIDER_CAPACITY_OBSERVATION",
        entityId: String(observation.id),
        data: {
          providerKey: input.providerKey,
          capability: input.capability,
          status: input.status,
          ttlSeconds: input.ttlSeconds,
          quotaResetAt: input.quotaResetAt,
        },
      });

      return observation;
    });
  }

  public async evaluateProviderDispatch(
    input: EvaluateProviderDispatchInput,
  ): Promise<Record<string, unknown>> {
    assertProviderKey(input.providerKey);
    if (input.capability !== "CODE_BUILDER") {
      throw new Error(
        "Provider dispatch conflict: execution work requires CODE_BUILDER capability",
      );
    }

    return this.transaction(async (client) => {
      const workResult = await client.query<DispatchWorkRow>(
        `SELECT
           work_item.id,
           work_item.project_id,
           work_item.status,
           work_item.state_version,
           budget_decision.id AS ai_budget_decision_id,
           budget_decision.execution_class
         FROM work_queue_items work_item
         JOIN LATERAL (
           SELECT decision.id,
                  decision.execution_class,
                  decision.decision
             FROM ai_budget_decisions decision
            WHERE decision.work_queue_item_id = work_item.id
              AND decision.project_id = work_item.project_id
              AND decision.queue_state_version = work_item.state_version
            ORDER BY decision.created_at DESC, decision.id DESC
            LIMIT 1
         ) budget_decision ON budget_decision.decision = 'APPROVED'
         WHERE work_item.id = $1
         FOR UPDATE OF work_item`,
        [input.workQueueItemId],
      );

      const work = workResult.rows[0];
      if (!work) {
        throw new Error(
          "Provider dispatch conflict: work item has no current approved budget decision",
        );
      }
      if (work.status !== "ELIGIBLE") {
        throw new Error(
          `Provider dispatch conflict: work status ${work.status} is not ELIGIBLE`,
        );
      }
      if (work.execution_class === "DETERMINISTIC") {
        throw new Error(
          "Provider dispatch conflict: deterministic work does not require provider readiness",
        );
      }

      const observationResult = await client.query<CapacityObservationRow>(
        `SELECT
           observation.id,
           observation.status,
           observation.expires_at > now() AS fresh
         FROM ai_provider_capacity_observations observation
         WHERE observation.project_id = $1
           AND observation.provider_key = $2
           AND observation.capability = $3
         ORDER BY observation.observed_at DESC, observation.id DESC
         LIMIT 1`,
        [work.project_id, input.providerKey, input.capability],
      );
      const observation = observationResult.rows[0] ?? null;
      const decision = evaluateProviderDispatchReadiness(
        observation
          ? { status: observation.status, fresh: observation.fresh }
          : null,
      );

      const result = await client.query(
        `INSERT INTO ai_provider_dispatch_decisions(
           project_id,
           work_queue_item_id,
           queue_state_version,
           ai_budget_decision_id,
           provider_key,
           capability,
           capacity_observation_id,
           outcome,
           waiting_reason,
           reason_code,
           created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          work.project_id,
          work.id,
          work.state_version,
          work.ai_budget_decision_id,
          input.providerKey,
          input.capability,
          observation?.id ?? null,
          decision.outcome,
          decision.waitingReason,
          decision.reason,
          input.actor.id,
        ],
      );
      const dispatchDecision = result.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: work.project_id,
        actor: input.actor,
        action: `AI_PROVIDER_DISPATCH_${decision.outcome}`,
        entityType: "AI_PROVIDER_DISPATCH_DECISION",
        entityId: String(dispatchDecision.id),
        data: {
          workQueueItemId: work.id,
          queueStateVersion: work.state_version,
          aiBudgetDecisionId: work.ai_budget_decision_id,
          providerKey: input.providerKey,
          capability: input.capability,
          capacityObservationId: observation?.id ?? null,
          outcome: decision.outcome,
          waitingReason: decision.waitingReason,
          reason: decision.reason,
        },
      });

      return dispatchDecision;
    });
  }

  public async getProjectProviderDispatchStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [observations, decisions] = await Promise.all([
      this.pool.query(
        `SELECT *
           FROM ai_provider_capacity_observations
          WHERE project_id = $1
          ORDER BY observed_at DESC, id DESC
          LIMIT 20`,
        [projectId],
      ),
      this.pool.query(
        `SELECT *
           FROM ai_provider_dispatch_decisions
          WHERE project_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 20`,
        [projectId],
      ),
    ]);

    return {
      recentProviderCapacityObservations: observations.rows,
      recentProviderDispatchDecisions: decisions.rows,
    };
  }

  public async getPlatformProviderDispatchStatus(): Promise<
    Record<string, unknown>
  > {
    const [capacityCounts, dispatchCounts] = await Promise.all([
      this.pool.query(
        `SELECT status, count(*)::text AS count
           FROM ai_provider_capacity_observations
          WHERE expires_at > now()
          GROUP BY status
          ORDER BY status`,
      ),
      this.pool.query(
        `SELECT outcome, waiting_reason, count(*)::text AS count
           FROM ai_provider_dispatch_decisions
          GROUP BY outcome, waiting_reason
          ORDER BY outcome, waiting_reason`,
      ),
    ]);

    return {
      providerCapacityCounts: capacityCounts.rows,
      providerDispatchDecisionCounts: dispatchCounts.rows,
    };
  }
}
