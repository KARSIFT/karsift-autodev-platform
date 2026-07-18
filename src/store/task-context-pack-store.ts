import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  TASK_CONTEXT_PACK_SCHEMA_VERSION,
  assertRepositorySnapshot,
  contractSection,
  normalizeRelevantPaths,
} from "../domain/task-context-pack.js";
import {
  sha256Json,
  type JsonValue,
} from "../domain/stable-json.js";
import type { Actor } from "./types.js";
import type {
  CreateTaskContextPackInput,
  TaskContextPackStore,
} from "./task-context-pack-types.js";

interface AttemptAccessRow extends QueryResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly status: string;
  readonly lease_active: boolean;
}

interface ExistingPackRow extends QueryResultRow {
  readonly id: string;
  readonly base_branch: string;
  readonly base_commit_sha: string;
  readonly relevant_paths: JsonValue;
  readonly content_hash: string;
  readonly content: JsonValue;
  readonly [key: string]: unknown;
}

interface PackContextRow extends QueryResultRow {
  readonly execution_attempt_id: string;
  readonly project_id: string;
  readonly attempt_number: number;
  readonly lease_owner: string;
  readonly lease_expires_at: string;
  readonly attempt_created_at: string;
  readonly claim_queue_state_version: number;
  readonly work_validation_run_id: string;
  readonly change_contract_authorization_decision_id: string;
  readonly ai_budget_decision_id: string;

  readonly project_slug: string;
  readonly project_name: string;
  readonly repository_full_name: string;
  readonly default_branch: string;
  readonly integration_branch: string;

  readonly work_queue_item_id: string;
  readonly work_priority: string;
  readonly execution_policy: string;
  readonly idempotency_key: string;

  readonly task_id: string;
  readonly task_title: string;
  readonly task_description: string;

  readonly change_contract_id: string;
  readonly change_contract_stable_id: string;
  readonly change_contract_version_id: string;
  readonly change_contract_version: number;
  readonly contract_content_hash: string;
  readonly contract_content: JsonValue;

  readonly validation_outcome: string;
  readonly validation_reason_code: string;
  readonly validation_checks: JsonValue;
  readonly validation_created_at: string;

  readonly authorization_policy_version: string;
  readonly authorization_risk_level: string;
  readonly authorization_decision: string;
  readonly authorization_reason_code: string;
  readonly authorization_required_authority: string;
  readonly authorization_policy_facts: JsonValue;
  readonly authorization_actor_type: string;
  readonly authorization_actor_id: string;
  readonly authorization_created_at: string;

  readonly budget_execution_class: string;
  readonly budget_estimated_max_cost_microusd: string;
  readonly budget_decision: string;
  readonly budget_reason_code: string;
  readonly budget_period_start: string;
  readonly budget_policy_monthly_limit_microusd: string | null;
  readonly budget_policy_per_work_limit_microusd: string | null;
  readonly budget_policy_max_ai_tier: number | null;
  readonly budget_committed_and_reserved_microusd: string;
  readonly budget_created_at: string;

  readonly reservation_id: string | null;
  readonly reservation_status: string | null;
  readonly reservation_reserved_microusd: string | null;
  readonly reservation_actual_cost_microusd: string | null;
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

function samePaths(existing: JsonValue, expected: readonly string[]): boolean {
  if (!Array.isArray(existing)) {
    return false;
  }
  return (
    existing.length === expected.length &&
    existing.every((value, index) => value === expected[index])
  );
}

export class PostgresTaskContextPackStore implements TaskContextPackStore {
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

  public async createTaskContextPack(
    input: CreateTaskContextPackInput,
  ): Promise<Record<string, unknown>> {
    assertRepositorySnapshot(input.baseBranch, input.baseCommitSha);
    const relevantPaths = normalizeRelevantPaths(input.relevantPaths);

    return this.transaction(async (client) => {
      const attemptResult = await client.query<AttemptAccessRow>(
        `SELECT
           id,
           project_id,
           status,
           lease_expires_at > now() AS lease_active
         FROM execution_attempts
         WHERE id = $1
           AND lease_token::text = $2
         FOR UPDATE`,
        [input.executionAttemptId, input.leaseToken],
      );
      const attempt = attemptResult.rows[0];
      if (!attempt) {
        throw new Error("Task Context Pack lease proof is invalid");
      }

      const existingResult = await client.query<ExistingPackRow>(
        `SELECT
           pack.*,
           pack.content #> '{repositorySnapshot,relevantPaths}' AS relevant_paths
         FROM task_context_packs pack
         WHERE pack.execution_attempt_id = $1`,
        [input.executionAttemptId],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (
          existing.base_branch !== input.baseBranch ||
          existing.base_commit_sha !== input.baseCommitSha ||
          !samePaths(existing.relevant_paths, relevantPaths)
        ) {
          throw new Error(
            "Task Context Pack conflict: an immutable pack already exists with a different repository snapshot",
          );
        }
        return existing as Record<string, unknown>;
      }

      if (attempt.status !== "ACTIVE" || !attempt.lease_active) {
        throw new Error(
          "Task Context Pack conflict: execution attempt must have an active unexpired lease",
        );
      }

      const contextResult = await client.query<PackContextRow>(
        `SELECT
           attempt.id AS execution_attempt_id,
           attempt.project_id,
           attempt.attempt_number,
           attempt.lease_owner,
           attempt.lease_expires_at::text,
           attempt.created_at::text AS attempt_created_at,
           attempt.claim_queue_state_version,
           attempt.work_validation_run_id,
           attempt.change_contract_authorization_decision_id,
           attempt.ai_budget_decision_id,

           project.slug AS project_slug,
           project.name AS project_name,
           project.repository_full_name,
           project.default_branch,
           project.integration_branch,

           work_item.id AS work_queue_item_id,
           work_item.priority AS work_priority,
           work_item.execution_policy,
           work_item.idempotency_key,

           task.id AS task_id,
           task.title AS task_title,
           task.description AS task_description,

           contract.id AS change_contract_id,
           contract.stable_id AS change_contract_stable_id,
           contract_version.id AS change_contract_version_id,
           contract_version.version AS change_contract_version,
           contract_version.content_hash AS contract_content_hash,
           contract_version.content AS contract_content,

           validation.outcome AS validation_outcome,
           validation.reason_code AS validation_reason_code,
           validation.checks AS validation_checks,
           validation.created_at::text AS validation_created_at,

           auth_decision.policy_version AS authorization_policy_version,
           auth_decision.risk_level AS authorization_risk_level,
           auth_decision.decision AS authorization_decision,
           auth_decision.reason_code AS authorization_reason_code,
           auth_decision.required_authority AS authorization_required_authority,
           auth_decision.policy_facts AS authorization_policy_facts,
           auth_decision.actor_type AS authorization_actor_type,
           auth_decision.actor_id AS authorization_actor_id,
           auth_decision.created_at::text AS authorization_created_at,

           budget_decision.execution_class AS budget_execution_class,
           budget_decision.estimated_max_cost_microusd::text AS budget_estimated_max_cost_microusd,
           budget_decision.decision AS budget_decision,
           budget_decision.reason_code AS budget_reason_code,
           budget_decision.period_start::text AS budget_period_start,
           budget_decision.policy_monthly_limit_microusd::text AS budget_policy_monthly_limit_microusd,
           budget_decision.policy_per_work_limit_microusd::text AS budget_policy_per_work_limit_microusd,
           budget_decision.policy_max_ai_tier AS budget_policy_max_ai_tier,
           budget_decision.committed_and_reserved_microusd::text AS budget_committed_and_reserved_microusd,
           budget_decision.created_at::text AS budget_created_at,

           reservation.id AS reservation_id,
           reservation.status AS reservation_status,
           reservation.reserved_microusd::text AS reservation_reserved_microusd,
           reservation.actual_cost_microusd::text AS reservation_actual_cost_microusd
         FROM execution_attempts attempt
         JOIN projects project
           ON project.id = attempt.project_id
         JOIN work_queue_items work_item
           ON work_item.id = attempt.work_queue_item_id
          AND work_item.project_id = attempt.project_id
         JOIN tasks task
           ON task.id = work_item.task_id
          AND task.project_id = attempt.project_id
         JOIN change_contract_versions contract_version
           ON contract_version.id = task.change_contract_version_id
          AND contract_version.project_id = attempt.project_id
         JOIN change_contracts contract
           ON contract.id = contract_version.contract_id
          AND contract.project_id = attempt.project_id
         JOIN work_validation_runs validation
           ON validation.id = attempt.work_validation_run_id
          AND validation.project_id = attempt.project_id
         JOIN change_contract_authorization_decisions auth_decision
           ON auth_decision.id = attempt.change_contract_authorization_decision_id
          AND auth_decision.project_id = attempt.project_id
         JOIN ai_budget_decisions budget_decision
           ON budget_decision.id = attempt.ai_budget_decision_id
          AND budget_decision.project_id = attempt.project_id
         LEFT JOIN ai_budget_reservations reservation
           ON reservation.budget_decision_id = budget_decision.id
          AND reservation.project_id = attempt.project_id
         WHERE attempt.id = $1`,
        [input.executionAttemptId],
      );

      const context = contextResult.rows[0];
      if (!context) {
        throw new Error(
          "Task Context Pack conflict: execution evidence is incomplete",
        );
      }

      const content: JsonValue = {
        schemaVersion: TASK_CONTEXT_PACK_SCHEMA_VERSION,
        project: {
          id: context.project_id,
          slug: context.project_slug,
          name: context.project_name,
          repositoryFullName: context.repository_full_name,
          defaultBranch: context.default_branch,
          integrationBranch: context.integration_branch,
        },
        objective: contractSection(context.contract_content, "objective", null),
        deliverables: contractSection(context.contract_content, "deliverables", []),
        acceptanceCriteria: contractSection(
          context.contract_content,
          "acceptanceCriteria",
          [],
        ),
        interfaces: contractSection(context.contract_content, "interfaces", []),
        tests: contractSection(context.contract_content, "tests", []),
        risks: contractSection(context.contract_content, "risks", []),
        prohibitedScope: contractSection(
          context.contract_content,
          "prohibitedScope",
          [],
        ),
        expectedEvidence: contractSection(
          context.contract_content,
          "expectedEvidence",
          [],
        ),
        governance: contractSection(
          context.contract_content,
          "governance",
          null,
        ),
        changeContract: {
          id: context.change_contract_id,
          stableId: context.change_contract_stable_id,
          versionId: context.change_contract_version_id,
          version: context.change_contract_version,
          contentHash: context.contract_content_hash,
          content: context.contract_content,
        },
        work: {
          workQueueItemId: context.work_queue_item_id,
          taskId: context.task_id,
          taskTitle: context.task_title,
          taskDescription: context.task_description,
          priority: context.work_priority,
          executionPolicy: context.execution_policy,
          idempotencyKey: context.idempotency_key,
          claimQueueStateVersion: context.claim_queue_state_version,
        },
        repositorySnapshot: {
          baseBranch: input.baseBranch,
          baseCommitSha: input.baseCommitSha,
          relevantPaths: [...relevantPaths],
        },
        evidence: {
          workValidation: {
            id: context.work_validation_run_id,
            outcome: context.validation_outcome,
            reasonCode: context.validation_reason_code,
            checks: context.validation_checks,
            createdAt: context.validation_created_at,
          },
          authorization: {
            id: context.change_contract_authorization_decision_id,
            policyVersion: context.authorization_policy_version,
            riskLevel: context.authorization_risk_level,
            decision: context.authorization_decision,
            reasonCode: context.authorization_reason_code,
            requiredAuthority: context.authorization_required_authority,
            policyFacts: context.authorization_policy_facts,
            actorType: context.authorization_actor_type,
            actorId: context.authorization_actor_id,
            createdAt: context.authorization_created_at,
          },
          budget: {
            id: context.ai_budget_decision_id,
            executionClass: context.budget_execution_class,
            estimatedMaxCostMicrousd:
              context.budget_estimated_max_cost_microusd,
            decision: context.budget_decision,
            reasonCode: context.budget_reason_code,
            periodStart: context.budget_period_start,
            policyMonthlyLimitMicrousd:
              context.budget_policy_monthly_limit_microusd,
            policyPerWorkLimitMicrousd:
              context.budget_policy_per_work_limit_microusd,
            policyMaxAiTier: context.budget_policy_max_ai_tier,
            committedAndReservedMicrousd:
              context.budget_committed_and_reserved_microusd,
            reservation:
              context.reservation_id === null
                ? null
                : {
                    id: context.reservation_id,
                    status: context.reservation_status,
                    reservedMicrousd: context.reservation_reserved_microusd,
                    actualCostMicrousd:
                      context.reservation_actual_cost_microusd,
                  },
            createdAt: context.budget_created_at,
          },
        },
        execution: {
          attemptId: context.execution_attempt_id,
          attemptNumber: context.attempt_number,
          leaseOwner: context.lease_owner,
          leaseExpiresAt: context.lease_expires_at,
          createdAt: context.attempt_created_at,
        },
      };
      const contentHash = sha256Json(content);

      const packResult = await client.query(
        `INSERT INTO task_context_packs(
           project_id,
           execution_attempt_id,
           work_queue_item_id,
           task_id,
           claim_queue_state_version,
           work_validation_run_id,
           change_contract_authorization_decision_id,
           ai_budget_decision_id,
           change_contract_id,
           change_contract_version_id,
           change_contract_version,
           contract_content_hash,
           repository_full_name,
           base_branch,
           base_commit_sha,
           content,
           content_hash,
           created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18
         )
         RETURNING *`,
        [
          context.project_id,
          context.execution_attempt_id,
          context.work_queue_item_id,
          context.task_id,
          context.claim_queue_state_version,
          context.work_validation_run_id,
          context.change_contract_authorization_decision_id,
          context.ai_budget_decision_id,
          context.change_contract_id,
          context.change_contract_version_id,
          context.change_contract_version,
          context.contract_content_hash,
          context.repository_full_name,
          input.baseBranch,
          input.baseCommitSha,
          JSON.stringify(content),
          contentHash,
          input.actor.id,
        ],
      );
      const pack = packResult.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action: "TASK_CONTEXT_PACK_CREATED",
        entityType: "TASK_CONTEXT_PACK",
        entityId: String(pack.id),
        data: {
          executionAttemptId: context.execution_attempt_id,
          workQueueItemId: context.work_queue_item_id,
          taskId: context.task_id,
          claimQueueStateVersion: context.claim_queue_state_version,
          workValidationRunId: context.work_validation_run_id,
          changeContractAuthorizationDecisionId:
            context.change_contract_authorization_decision_id,
          aiBudgetDecisionId: context.ai_budget_decision_id,
          changeContractVersionId: context.change_contract_version_id,
          contractContentHash: context.contract_content_hash,
          baseBranch: input.baseBranch,
          baseCommitSha: input.baseCommitSha,
          contentHash,
        },
      });

      return pack;
    });
  }

  public async getTaskContextPack(
    executionAttemptId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT *
         FROM task_context_packs
        WHERE execution_attempt_id = $1`,
      [executionAttemptId],
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  public async getProjectTaskContextPackStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [count, recent] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::text AS task_context_pack_count
           FROM task_context_packs
          WHERE project_id = $1`,
        [projectId],
      ),
      this.pool.query(
        `SELECT id,
                execution_attempt_id,
                work_queue_item_id,
                task_id,
                change_contract_version_id,
                base_branch,
                base_commit_sha,
                content_hash,
                created_at
           FROM task_context_packs
          WHERE project_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 20`,
        [projectId],
      ),
    ]);

    return {
      taskContextPackCount: count.rows[0]?.task_context_pack_count ?? "0",
      recentTaskContextPacks: recent.rows,
    };
  }

  public async getPlatformTaskContextPackStatus(): Promise<
    Record<string, unknown>
  > {
    const result = await this.pool.query(
      `SELECT count(*)::text AS task_context_pack_count
         FROM task_context_packs`,
    );
    return {
      taskContextPackCount: result.rows[0]?.task_context_pack_count ?? "0",
    };
  }
}
