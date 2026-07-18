import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  assertBuilderAdapterResult,
  assertBuilderExecutionLimits,
  buildBuilderInvocationPlanContent,
  hashBuilderInvocationPlan,
  type BuilderAdapterResult,
  type BuilderExecutionLimits,
} from "../domain/builder-runtime.js";
import { sha256Json, type JsonValue } from "../domain/stable-json.js";
import type {
  BuilderRuntimeStore,
  CompleteBuilderInvocationInput,
  PrepareBuilderInvocationInput,
  StartBuilderInvocationInput,
} from "./builder-runtime-types.js";
import type { Actor } from "./types.js";

interface BuilderPreparationRow extends QueryResultRow {
  readonly execution_attempt_id: string;
  readonly project_id: string;
  readonly attempt_status: string;
  readonly lease_active: boolean;
  readonly task_context_pack_id: string;
  readonly task_context_pack_hash: string;
  readonly provider_dispatch_decision_id: string;
  readonly provider_key: string;
}

interface ExistingPlanRow extends QueryResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly execution_attempt_id: string;
  readonly plan_hash: string;
  readonly plan_content: JsonValue;
}

interface StartContextRow extends QueryResultRow {
  readonly invocation_id: string;
  readonly project_id: string;
  readonly status: string;
  readonly state_version: number;
  readonly execution_attempt_id: string;
  readonly attempt_status: string;
  readonly lease_active: boolean;
  readonly plan_id: string;
  readonly adapter_key: string;
  readonly side_effect_mode: string;
  readonly plan_hash: string;
  readonly task_context_pack_hash: string;
  readonly provider_key: string;
  readonly max_turns: number;
  readonly retry_budget: number;
  readonly command_budget: number;
  readonly timeout_seconds: number;
  readonly provider_ready: boolean;
  readonly ai_dispatch_enabled: boolean;
}

interface CompleteContextRow extends QueryResultRow {
  readonly invocation_id: string;
  readonly project_id: string;
  readonly status: string;
  readonly state_version: number;
  readonly max_turns: number;
  readonly retry_budget: number;
  readonly command_budget: number;
  readonly timeout_seconds: number;
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

function limitsFromRow(row: {
  readonly max_turns: number;
  readonly retry_budget: number;
  readonly command_budget: number;
  readonly timeout_seconds: number;
}): BuilderExecutionLimits {
  return {
    maxTurns: row.max_turns,
    retryBudget: row.retry_budget,
    commandBudget: row.command_budget,
    timeoutSeconds: row.timeout_seconds,
  };
}

function resultEvidenceHash(result: BuilderAdapterResult): string {
  return sha256Json({
    outcome: result.outcome,
    turnsUsed: result.turnsUsed,
    commandsUsed: result.commandsUsed,
    durationMs: result.durationMs,
    summary: result.summary,
    evidence: result.evidence,
  });
}

export class PostgresBuilderRuntimeStore implements BuilderRuntimeStore {
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

  public async prepareBuilderInvocation(
    input: PrepareBuilderInvocationInput,
  ): Promise<Record<string, unknown>> {
    assertBuilderExecutionLimits(input.limits);

    return this.transaction(async (client) => {
      const contextResult = await client.query<BuilderPreparationRow>(
        `SELECT
           attempt.id AS execution_attempt_id,
           attempt.project_id,
           attempt.status AS attempt_status,
           attempt.lease_expires_at > now() AS lease_active,
           context_pack.id AS task_context_pack_id,
           context_pack.content_hash AS task_context_pack_hash,
           dispatch_decision.id AS provider_dispatch_decision_id,
           dispatch_decision.provider_key
         FROM execution_attempts attempt
         JOIN task_context_packs context_pack
           ON context_pack.execution_attempt_id = attempt.id
          AND context_pack.project_id = attempt.project_id
         JOIN ai_provider_dispatch_decisions dispatch_decision
           ON dispatch_decision.id = attempt.provider_dispatch_decision_id
          AND dispatch_decision.project_id = attempt.project_id
         WHERE attempt.id = $1
           AND attempt.lease_token::text = $2
         FOR UPDATE OF attempt`,
        [input.executionAttemptId, input.leaseToken],
      );
      const context = contextResult.rows[0];
      if (!context) {
        throw new Error(
          "Builder invocation conflict: lease proof or execution evidence is invalid",
        );
      }
      if (context.attempt_status !== "ACTIVE" || !context.lease_active) {
        throw new Error(
          "Builder invocation conflict: execution attempt must be active and unexpired",
        );
      }

      const planContent = buildBuilderInvocationPlanContent({
        executionAttemptId: context.execution_attempt_id,
        taskContextPackId: context.task_context_pack_id,
        taskContextPackHash: context.task_context_pack_hash,
        providerDispatchDecisionId: context.provider_dispatch_decision_id,
        providerKey: context.provider_key,
        adapterKey: "dry-run",
        sideEffectMode: "NONE",
        limits: input.limits,
      });
      const planHash = hashBuilderInvocationPlan(planContent);

      const existingPlanResult = await client.query<ExistingPlanRow>(
        `SELECT id, project_id, execution_attempt_id, plan_hash, plan_content
           FROM builder_invocation_plans
          WHERE execution_attempt_id = $1`,
        [input.executionAttemptId],
      );
      const existingPlan = existingPlanResult.rows[0];
      if (existingPlan) {
        if (existingPlan.plan_hash !== planHash) {
          throw new Error(
            "Builder invocation conflict: an immutable plan already exists with different execution limits",
          );
        }
        const existingInvocation = await client.query(
          `SELECT *
             FROM builder_invocations
            WHERE builder_invocation_plan_id = $1`,
          [existingPlan.id],
        );
        return {
          plan: existingPlan as Record<string, unknown>,
          invocation: existingInvocation.rows[0] as Record<string, unknown>,
        };
      }

      const planResult = await client.query(
        `INSERT INTO builder_invocation_plans(
           project_id,
           execution_attempt_id,
           task_context_pack_id,
           task_context_pack_hash,
           provider_dispatch_decision_id,
           provider_key,
           adapter_key,
           side_effect_mode,
           max_turns,
           retry_budget,
           command_budget,
           timeout_seconds,
           plan_content,
           plan_hash,
           created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'dry-run', 'NONE', $7, $8, $9, $10, $11::jsonb, $12, $13
         )
         RETURNING *`,
        [
          context.project_id,
          context.execution_attempt_id,
          context.task_context_pack_id,
          context.task_context_pack_hash,
          context.provider_dispatch_decision_id,
          context.provider_key,
          input.limits.maxTurns,
          input.limits.retryBudget,
          input.limits.commandBudget,
          input.limits.timeoutSeconds,
          JSON.stringify(planContent),
          planHash,
          input.actor.id,
        ],
      );
      const plan = planResult.rows[0] as Record<string, unknown>;

      const invocationResult = await client.query(
        `INSERT INTO builder_invocations(
           project_id, builder_invocation_plan_id, execution_attempt_id
         ) VALUES ($1, $2, $3)
         RETURNING *`,
        [context.project_id, plan.id, context.execution_attempt_id],
      );
      const invocation = invocationResult.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action: "BUILDER_INVOCATION_PREPARED",
        entityType: "BUILDER_INVOCATION",
        entityId: String(invocation.id),
        data: {
          executionAttemptId: context.execution_attempt_id,
          taskContextPackId: context.task_context_pack_id,
          taskContextPackHash: context.task_context_pack_hash,
          providerDispatchDecisionId: context.provider_dispatch_decision_id,
          providerKey: context.provider_key,
          adapterKey: "dry-run",
          sideEffectMode: "NONE",
          planHash,
        },
      });

      return { plan, invocation };
    });
  }

  public async startBuilderInvocation(
    input: StartBuilderInvocationInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const contextResult = await client.query<StartContextRow>(
        `SELECT
           invocation.id AS invocation_id,
           invocation.project_id,
           invocation.status,
           invocation.state_version,
           invocation.execution_attempt_id,
           attempt.status AS attempt_status,
           attempt.lease_expires_at > now() AS lease_active,
           plan.id AS plan_id,
           plan.adapter_key,
           plan.side_effect_mode,
           plan.plan_hash,
           plan.task_context_pack_hash,
           plan.provider_key,
           plan.max_turns,
           plan.retry_budget,
           plan.command_budget,
           plan.timeout_seconds,
           (
             dispatch_decision.outcome = 'READY'
             AND dispatch_decision.waiting_reason = 'NONE'
             AND capacity.status = 'HEALTHY'
             AND capacity.expires_at > now()
           ) AS provider_ready,
           is_effective_capability_enabled(invocation.project_id, 'AI_DISPATCH')
             AS ai_dispatch_enabled
         FROM builder_invocations invocation
         JOIN builder_invocation_plans plan
           ON plan.id = invocation.builder_invocation_plan_id
          AND plan.project_id = invocation.project_id
         JOIN execution_attempts attempt
           ON attempt.id = invocation.execution_attempt_id
          AND attempt.project_id = invocation.project_id
         JOIN ai_provider_dispatch_decisions dispatch_decision
           ON dispatch_decision.id = plan.provider_dispatch_decision_id
          AND dispatch_decision.project_id = invocation.project_id
         JOIN ai_provider_capacity_observations capacity
           ON capacity.id = dispatch_decision.capacity_observation_id
          AND capacity.project_id = invocation.project_id
         WHERE invocation.id = $1
         FOR UPDATE OF invocation`,
        [input.builderInvocationId],
      );
      const context = contextResult.rows[0];
      if (!context) {
        throw new Error(`Builder invocation not found: ${input.builderInvocationId}`);
      }
      if (context.status === "RUNNING") {
        return {
          invocation: context as unknown as Record<string, unknown>,
          plan: {
            id: context.plan_id,
            adapter_key: context.adapter_key,
            side_effect_mode: context.side_effect_mode,
            plan_hash: context.plan_hash,
            task_context_pack_hash: context.task_context_pack_hash,
            provider_key: context.provider_key,
            max_turns: context.max_turns,
            retry_budget: context.retry_budget,
            command_budget: context.command_budget,
            timeout_seconds: context.timeout_seconds,
          },
        };
      }
      if (context.status !== "PREPARED") {
        throw new Error(
          `Builder invocation conflict: status ${context.status} cannot start`,
        );
      }
      if (context.attempt_status !== "ACTIVE" || !context.lease_active) {
        throw new Error(
          "Builder invocation conflict: execution attempt is no longer active",
        );
      }
      if (!context.provider_ready) {
        throw new Error(
          "Builder invocation conflict: provider readiness is no longer valid",
        );
      }
      if (!context.ai_dispatch_enabled) {
        throw new Error(
          "Builder invocation conflict: AI_DISPATCH capability is not enabled",
        );
      }
      if (context.adapter_key !== "dry-run" || context.side_effect_mode !== "NONE") {
        throw new Error(
          "Builder invocation conflict: only the no-side-effect dry-run adapter is supported",
        );
      }

      const invocationResult = await client.query(
        `UPDATE builder_invocations
            SET status = 'RUNNING',
                state_version = state_version + 1,
                started_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [input.builderInvocationId],
      );
      const invocation = invocationResult.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action: "BUILDER_INVOCATION_STARTED",
        entityType: "BUILDER_INVOCATION",
        entityId: input.builderInvocationId,
        data: {
          executionAttemptId: context.execution_attempt_id,
          adapterKey: context.adapter_key,
          sideEffectMode: context.side_effect_mode,
          planHash: context.plan_hash,
        },
      });

      return {
        invocation,
        plan: {
          id: context.plan_id,
          adapter_key: context.adapter_key,
          side_effect_mode: context.side_effect_mode,
          plan_hash: context.plan_hash,
          task_context_pack_hash: context.task_context_pack_hash,
          provider_key: context.provider_key,
          max_turns: context.max_turns,
          retry_budget: context.retry_budget,
          command_budget: context.command_budget,
          timeout_seconds: context.timeout_seconds,
        },
      };
    });
  }

  public async completeBuilderInvocation(
    input: CompleteBuilderInvocationInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const contextResult = await client.query<CompleteContextRow>(
        `SELECT
           invocation.id AS invocation_id,
           invocation.project_id,
           invocation.status,
           invocation.state_version,
           plan.max_turns,
           plan.retry_budget,
           plan.command_budget,
           plan.timeout_seconds
         FROM builder_invocations invocation
         JOIN builder_invocation_plans plan
           ON plan.id = invocation.builder_invocation_plan_id
          AND plan.project_id = invocation.project_id
         WHERE invocation.id = $1
         FOR UPDATE OF invocation`,
        [input.builderInvocationId],
      );
      const context = contextResult.rows[0];
      if (!context) {
        throw new Error(`Builder invocation not found: ${input.builderInvocationId}`);
      }

      const limits = limitsFromRow(context);
      assertBuilderAdapterResult(input.result, limits);
      const evidenceHash = resultEvidenceHash(input.result);

      if (context.status === "SUCCEEDED" || context.status === "FAILED") {
        const existingResult = await client.query(
          `SELECT *
             FROM builder_invocation_results
            WHERE builder_invocation_id = $1`,
          [input.builderInvocationId],
        );
        const existing = existingResult.rows[0] as Record<string, unknown> | undefined;
        if (!existing || existing.evidence_hash !== evidenceHash) {
          throw new Error(
            "Builder invocation conflict: terminal invocation has different immutable result evidence",
          );
        }
        return { invocation: context as unknown as Record<string, unknown>, result: existing };
      }
      if (context.status !== "RUNNING") {
        throw new Error(
          `Builder invocation conflict: status ${context.status} cannot complete`,
        );
      }

      const resultResult = await client.query(
        `INSERT INTO builder_invocation_results(
           project_id,
           builder_invocation_id,
           outcome,
           turns_used,
           commands_used,
           duration_ms,
           summary,
           evidence,
           evidence_hash,
           created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
         RETURNING *`,
        [
          context.project_id,
          input.builderInvocationId,
          input.result.outcome,
          input.result.turnsUsed,
          input.result.commandsUsed,
          input.result.durationMs,
          input.result.summary,
          JSON.stringify(input.result.evidence),
          evidenceHash,
          input.actor.id,
        ],
      );
      const result = resultResult.rows[0] as Record<string, unknown>;

      const invocationResult = await client.query(
        `UPDATE builder_invocations
            SET status = $2,
                state_version = state_version + 1,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [input.builderInvocationId, input.result.outcome],
      );
      const invocation = invocationResult.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action: `BUILDER_INVOCATION_${input.result.outcome}`,
        entityType: "BUILDER_INVOCATION",
        entityId: input.builderInvocationId,
        data: {
          evidenceHash,
          turnsUsed: input.result.turnsUsed,
          commandsUsed: input.result.commandsUsed,
          durationMs: input.result.durationMs,
        },
      });

      return { invocation, result };
    });
  }

  public async getBuilderInvocation(
    builderInvocationId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT invocation.*,
              row_to_json(plan) AS plan,
              row_to_json(result_row) AS result
         FROM builder_invocations invocation
         JOIN builder_invocation_plans plan
           ON plan.id = invocation.builder_invocation_plan_id
          AND plan.project_id = invocation.project_id
         LEFT JOIN builder_invocation_results result_row
           ON result_row.builder_invocation_id = invocation.id
          AND result_row.project_id = invocation.project_id
        WHERE invocation.id = $1`,
      [builderInvocationId],
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  public async getProjectBuilderRuntimeStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [counts, recent] = await Promise.all([
      this.pool.query(
        `SELECT status, count(*)::text AS count
           FROM builder_invocations
          WHERE project_id = $1
          GROUP BY status
          ORDER BY status`,
        [projectId],
      ),
      this.pool.query(
        `SELECT invocation.id,
                invocation.execution_attempt_id,
                invocation.status,
                invocation.state_version,
                plan.adapter_key,
                plan.side_effect_mode,
                plan.provider_key,
                plan.plan_hash,
                invocation.created_at,
                invocation.started_at,
                invocation.completed_at
           FROM builder_invocations invocation
           JOIN builder_invocation_plans plan
             ON plan.id = invocation.builder_invocation_plan_id
            AND plan.project_id = invocation.project_id
          WHERE invocation.project_id = $1
          ORDER BY invocation.created_at DESC, invocation.id DESC
          LIMIT 20`,
        [projectId],
      ),
    ]);
    return {
      builderInvocationCounts: counts.rows,
      recentBuilderInvocations: recent.rows,
    };
  }

  public async getPlatformBuilderRuntimeStatus(): Promise<
    Record<string, unknown>
  > {
    const counts = await this.pool.query(
      `SELECT status, count(*)::text AS count
         FROM builder_invocations
        GROUP BY status
        ORDER BY status`,
    );
    return { builderInvocationCounts: counts.rows };
  }
}
