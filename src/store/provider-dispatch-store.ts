import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  assertProviderKey,
  evaluateProviderRoute,
  normalizeProviderKeys,
  type ProviderCapacityStatus,
  type ProviderRouteCandidate,
} from "../domain/provider-capacity.js";
import type { JsonValue } from "../domain/stable-json.js";
import type {
  EvaluateProviderDispatchInput,
  ProviderDispatchStore,
  RecordProviderCapacityObservationInput,
  UpsertProviderRoutingPolicyInput,
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

interface RoutingPolicyRow extends QueryResultRow {
  readonly provider_keys: string[];
  readonly enabled: boolean;
  readonly version: number;
}

interface CandidateObservationRow extends QueryResultRow {
  readonly provider_key: string;
  readonly provider_rank: number;
  readonly id: string | null;
  readonly status: ProviderCapacityStatus | null;
  readonly fresh: boolean | null;
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

  public async upsertProviderRoutingPolicy(
    input: UpsertProviderRoutingPolicyInput,
  ): Promise<Record<string, unknown>> {
    const providerKeys = normalizeProviderKeys(input.providerKeys);

    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO ai_provider_routing_policies(
           project_id,
           execution_class,
           capability,
           provider_keys,
           enabled,
           updated_by
         ) VALUES ($1, $2, $3, $4::text[], $5, $6)
         ON CONFLICT (project_id, execution_class, capability) DO UPDATE
             SET provider_keys = EXCLUDED.provider_keys,
                 enabled = EXCLUDED.enabled,
                 version = ai_provider_routing_policies.version + 1,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = now()
         RETURNING *`,
        [
          input.projectId,
          input.executionClass,
          input.capability,
          providerKeys,
          input.enabled,
          input.actor.id,
        ],
      );
      const policy = result.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: input.projectId,
        actor: input.actor,
        action: "AI_PROVIDER_ROUTING_POLICY_UPSERTED",
        entityType: "AI_PROVIDER_ROUTING_POLICY",
        entityId: `${input.projectId}:${input.executionClass}:${input.capability}`,
        data: {
          executionClass: input.executionClass,
          capability: input.capability,
          providerKeys: [...providerKeys],
          enabled: input.enabled,
          version: Number(policy.version),
        },
      });

      return policy;
    });
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

      const policyResult = await client.query<RoutingPolicyRow>(
        `SELECT provider_keys, enabled, version
           FROM ai_provider_routing_policies
          WHERE project_id = $1
            AND execution_class = $2
            AND capability = $3
          FOR SHARE`,
        [work.project_id, work.execution_class, input.capability],
      );
      const policy = policyResult.rows[0] ?? null;
      const providerKeys = policy?.enabled ? normalizeProviderKeys(policy.provider_keys) : [];

      let observationRows: CandidateObservationRow[] = [];
      if (providerKeys.length > 0) {
        const observationResult = await client.query<CandidateObservationRow>(
          `SELECT
             candidate.provider_key,
             candidate.provider_rank::integer AS provider_rank,
             observation.id,
             observation.status,
             observation.expires_at > now() AS fresh
           FROM unnest($1::text[]) WITH ORDINALITY
                AS candidate(provider_key, provider_rank)
           LEFT JOIN LATERAL (
             SELECT capacity.id,
                    capacity.status,
                    capacity.expires_at
               FROM ai_provider_capacity_observations capacity
              WHERE capacity.project_id = $2
                AND capacity.provider_key = candidate.provider_key
                AND capacity.capability = $3
              ORDER BY capacity.observed_at DESC, capacity.id DESC
              LIMIT 1
           ) observation ON true
           ORDER BY candidate.provider_rank`,
          [providerKeys, work.project_id, input.capability],
        );
        observationRows = observationResult.rows;
      }

      const routeCandidates: ProviderRouteCandidate[] = observationRows.map((row) => ({
        providerKey: row.provider_key,
        rank: row.provider_rank,
        capacity:
          row.id === null || row.status === null
            ? null
            : { status: row.status, fresh: row.fresh === true },
      }));
      const decision = evaluateProviderRoute(routeCandidates);
      const selectedObservation =
        decision.providerRank === null
          ? null
          : observationRows.find(
              (row) =>
                row.provider_rank === decision.providerRank &&
                row.provider_key === decision.providerKey,
            ) ?? null;

      const result = await client.query(
        `INSERT INTO ai_provider_dispatch_decisions(
           project_id,
           work_queue_item_id,
           queue_state_version,
           ai_budget_decision_id,
           routing_policy_version,
           candidate_provider_keys,
           provider_key,
           selected_provider_rank,
           capability,
           capacity_observation_id,
           outcome,
           waiting_reason,
           reason_code,
           created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, $12, $13, $14
         )
         RETURNING *`,
        [
          work.project_id,
          work.id,
          work.state_version,
          work.ai_budget_decision_id,
          policy?.version ?? 0,
          providerKeys,
          decision.providerKey,
          decision.providerRank,
          input.capability,
          selectedObservation?.id ?? null,
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
          routingPolicyVersion: policy?.version ?? 0,
          candidateProviderKeys: [...providerKeys],
          providerKey: decision.providerKey,
          providerRank: decision.providerRank,
          capability: input.capability,
          capacityObservationId: selectedObservation?.id ?? null,
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
    const [policies, observations, decisions] = await Promise.all([
      this.pool.query(
        `SELECT *
           FROM ai_provider_routing_policies
          WHERE project_id = $1
          ORDER BY execution_class, capability`,
        [projectId],
      ),
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
      providerRoutingPolicies: policies.rows,
      recentProviderCapacityObservations: observations.rows,
      recentProviderDispatchDecisions: decisions.rows,
    };
  }

  public async getPlatformProviderDispatchStatus(): Promise<
    Record<string, unknown>
  > {
    const [policyCount, capacityCounts, dispatchCounts] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::text AS provider_routing_policy_count
           FROM ai_provider_routing_policies
          WHERE enabled = true`,
      ),
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
      providerRoutingPolicyCount:
        policyCount.rows[0]?.provider_routing_policy_count ?? "0",
      providerCapacityCounts: capacityCounts.rows,
      providerDispatchDecisionCounts: dispatchCounts.rows,
    };
  }
}
