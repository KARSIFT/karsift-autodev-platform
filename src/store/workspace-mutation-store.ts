import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  assertWorkspaceMutationScope,
  buildWorkspaceMutationPlanContent,
  hashWorkspaceMutationPlan,
  normalizeWorkspaceMutationOperations,
  workspaceMutationTotalContentBytes,
  type WorkspaceMutationOperation,
} from "../domain/workspace-mutation.js";
import { sha256Json, type JsonValue } from "../domain/stable-json.js";
import type {
  ClaimWorkspaceMutationRunResult,
  CompleteWorkspaceMutationRunInput,
  PrepareWorkspaceMutationInput,
  WorkspaceMutationStore,
} from "./workspace-mutation-types.js";
import type { Actor } from "./types.js";

interface WorkspaceMutationContextRow extends QueryResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly status: string;
  readonly state_version: number;
  readonly workspace_path: string | null;
  readonly repository_workspace_plan_id: string;
  readonly builder_invocation_id: string;
  readonly mode: string;
  readonly relevant_paths: JsonValue;
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

function stringArray(value: JsonValue, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Workspace mutation conflict: ${field} must be a string array`);
  }
  return value as string[];
}

function operationsJson(operations: readonly WorkspaceMutationOperation[]): JsonValue {
  return operations.map((operation) => ({
    type: operation.type,
    path: operation.path,
    expectedBeforeHash: operation.expectedBeforeHash,
    content: operation.content,
  }));
}

export class PostgresWorkspaceMutationStore implements WorkspaceMutationStore {
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

  public async prepareWorkspaceMutation(
    input: PrepareWorkspaceMutationInput,
  ): Promise<Record<string, unknown>> {
    const operations = normalizeWorkspaceMutationOperations(input.operations);

    return this.transaction(async (client) => {
      const contextResult = await client.query<WorkspaceMutationContextRow>(
        `SELECT workspace.id,
                workspace.project_id,
                workspace.status,
                workspace.state_version,
                workspace.workspace_path,
                workspace.repository_workspace_plan_id,
                plan.builder_invocation_id,
                plan.mode,
                plan.relevant_paths
           FROM repository_workspaces workspace
           JOIN repository_workspace_plans plan
             ON plan.id = workspace.repository_workspace_plan_id
            AND plan.project_id = workspace.project_id
          WHERE workspace.id = $1
          FOR UPDATE OF workspace`,
        [input.repositoryWorkspaceId],
      );
      const context = contextResult.rows[0];
      if (!context) {
        throw new Error(`Repository workspace not found: ${input.repositoryWorkspaceId}`);
      }
      if (context.status !== "MATERIALIZED" || !context.workspace_path) {
        throw new Error(
          `Workspace mutation conflict: workspace status ${context.status} is not MATERIALIZED`,
        );
      }
      if (context.mode !== "WRITE") {
        throw new Error("Workspace mutation conflict: repository workspace is not WRITE mode");
      }

      const relevantPaths = stringArray(context.relevant_paths, "relevant paths");
      assertWorkspaceMutationScope(relevantPaths, operations);
      const planInput = {
        projectId: context.project_id,
        repositoryWorkspaceId: context.id,
        repositoryWorkspacePlanId: context.repository_workspace_plan_id,
        builderInvocationId: context.builder_invocation_id,
        workspaceStateVersion: context.state_version,
        workspacePath: context.workspace_path,
        relevantPaths,
        operations,
      } as const;
      const planContent = buildWorkspaceMutationPlanContent(planInput);
      const planHash = hashWorkspaceMutationPlan(planInput);
      const totalContentBytes = workspaceMutationTotalContentBytes(operations);

      const existingResult = await client.query(
        `SELECT plan.*,
                row_to_json(run) AS run
           FROM workspace_mutation_plans plan
           JOIN workspace_mutation_runs run
             ON run.workspace_mutation_plan_id = plan.id
            AND run.project_id = plan.project_id
          WHERE plan.project_id = $1
            AND plan.plan_hash = $2`,
        [context.project_id, planHash],
      );
      const existing = existingResult.rows[0] as Record<string, unknown> | undefined;
      if (existing) {
        return { plan: existing, run: existing.run as Record<string, unknown> };
      }

      const planResult = await client.query(
        `INSERT INTO workspace_mutation_plans(
           project_id, repository_workspace_id, repository_workspace_plan_id,
           builder_invocation_id, workspace_state_version, workspace_path,
           relevant_paths, operations, operation_count, total_content_bytes,
           plan_content, plan_hash, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
           $9, $10, $11::jsonb, $12, $13
         )
         RETURNING *`,
        [
          context.project_id,
          context.id,
          context.repository_workspace_plan_id,
          context.builder_invocation_id,
          context.state_version,
          context.workspace_path,
          JSON.stringify(relevantPaths),
          JSON.stringify(operationsJson(operations)),
          operations.length,
          totalContentBytes,
          JSON.stringify(planContent),
          planHash,
          input.actor.id,
        ],
      );
      const plan = planResult.rows[0] as Record<string, unknown>;
      const runResult = await client.query(
        `INSERT INTO workspace_mutation_runs(
           project_id, repository_workspace_id, workspace_mutation_plan_id
         ) VALUES ($1, $2, $3)
         RETURNING *`,
        [context.project_id, context.id, plan.id],
      );
      const run = runResult.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action: "WORKSPACE_MUTATION_PREPARED",
        entityType: "WORKSPACE_MUTATION_RUN",
        entityId: String(run.id),
        data: {
          repositoryWorkspaceId: context.id,
          builderInvocationId: context.builder_invocation_id,
          operationCount: operations.length,
          totalContentBytes,
          planHash,
        },
      });
      return { plan, run };
    });
  }

  public async claimWorkspaceMutationRun(
    workspaceMutationRunId: string,
    actor: Actor,
  ): Promise<ClaimWorkspaceMutationRunResult> {
    try {
      return await this.transaction(async (client) => {
        const claimResult = await client.query(
          `UPDATE workspace_mutation_runs
              SET status = 'APPLYING',
                  state_version = state_version + 1,
                  started_at = now(),
                  updated_at = now()
            WHERE id = $1
              AND status = 'PREPARED'
            RETURNING *`,
          [workspaceMutationRunId],
        );

        const currentResult = await client.query(
          `SELECT run.*,
                  row_to_json(plan) AS plan
             FROM workspace_mutation_runs run
             JOIN workspace_mutation_plans plan
               ON plan.id = run.workspace_mutation_plan_id
              AND plan.project_id = run.project_id
            WHERE run.id = $1`,
          [workspaceMutationRunId],
        );
        const current = currentResult.rows[0] as Record<string, unknown> | undefined;
        if (!current) {
          throw new Error(`Workspace mutation run not found: ${workspaceMutationRunId}`);
        }
        const plan = current.plan as Record<string, unknown>;
        const claimed = claimResult.rowCount === 1;
        if (claimed) {
          await appendAudit(client, {
            projectId: String(current.project_id),
            actor,
            action: "WORKSPACE_MUTATION_CLAIMED",
            entityType: "WORKSPACE_MUTATION_RUN",
            entityId: workspaceMutationRunId,
            data: { planHash: String(plan.plan_hash) },
          });
        }
        return { claimed, run: current, plan };
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const current = await this.getWorkspaceMutationRun(workspaceMutationRunId);
        if (!current) {
          throw new Error(`Workspace mutation run not found: ${workspaceMutationRunId}`);
        }
        return {
          claimed: false,
          run: current,
          plan: current.plan as Record<string, unknown>,
        };
      }
      throw error;
    }
  }

  public async completeWorkspaceMutationRun(
    input: CompleteWorkspaceMutationRunInput,
  ): Promise<Record<string, unknown>> {
    if (!Number.isInteger(input.durationMs) || input.durationMs < 0) {
      throw new Error("Workspace mutation durationMs must be a non-negative integer");
    }
    if (
      input.errorCode !== null &&
      !/^[A-Z0-9_]{1,64}$/.test(input.errorCode)
    ) {
      throw new Error("Workspace mutation errorCode must be null or a stable uppercase code");
    }

    return this.transaction(async (client) => {
      const currentResult = await client.query(
        `SELECT run.*,
                row_to_json(plan) AS plan,
                row_to_json(evidence) AS evidence
           FROM workspace_mutation_runs run
           JOIN workspace_mutation_plans plan
             ON plan.id = run.workspace_mutation_plan_id
            AND plan.project_id = run.project_id
           LEFT JOIN workspace_mutation_evidence evidence
             ON evidence.workspace_mutation_run_id = run.id
            AND evidence.project_id = run.project_id
          WHERE run.id = $1
          FOR UPDATE OF run`,
        [input.workspaceMutationRunId],
      );
      const current = currentResult.rows[0] as Record<string, unknown> | undefined;
      if (!current) {
        throw new Error(`Workspace mutation run not found: ${input.workspaceMutationRunId}`);
      }
      if (["APPLIED", "FAILED"].includes(String(current.status))) {
        return current;
      }
      if (current.status !== "APPLYING") {
        throw new Error(
          `Workspace mutation conflict: run status ${String(current.status)} cannot complete`,
        );
      }
      const plan = current.plan as Record<string, unknown>;
      const pathEvidence = input.pathEvidence.map((entry) => ({
        type: entry.type,
        path: entry.path,
        beforeHash: entry.beforeHash,
        afterHash: entry.afterHash,
        beforeBytes: entry.beforeBytes,
        afterBytes: entry.afterBytes,
      }));
      const resultContent: JsonValue = {
        workspaceMutationRunId: input.workspaceMutationRunId,
        planHash: String(plan.plan_hash),
        outcome: input.outcome,
        durationMs: input.durationMs,
        pathEvidence,
        errorCode: input.errorCode,
      };
      const resultHash = sha256Json(resultContent);

      const evidenceResult = await client.query(
        `INSERT INTO workspace_mutation_evidence(
           project_id, workspace_mutation_run_id, outcome, duration_ms,
           path_evidence, error_code, result_hash, created_by
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         RETURNING *`,
        [
          current.project_id,
          input.workspaceMutationRunId,
          input.outcome,
          input.durationMs,
          JSON.stringify(pathEvidence),
          input.errorCode,
          resultHash,
          input.actor.id,
        ],
      );
      const evidence = evidenceResult.rows[0] as Record<string, unknown>;
      const runResult = await client.query(
        `UPDATE workspace_mutation_runs
            SET status = $2,
                state_version = state_version + 1,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [input.workspaceMutationRunId, input.outcome],
      );
      const run = runResult.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: String(current.project_id),
        actor: input.actor,
        action: "WORKSPACE_MUTATION_COMPLETED",
        entityType: "WORKSPACE_MUTATION_RUN",
        entityId: input.workspaceMutationRunId,
        data: {
          outcome: input.outcome,
          resultHash,
          operationCount: pathEvidence.length,
          errorCode: input.errorCode,
        },
      });
      return { run, plan, evidence };
    });
  }

  public async getWorkspaceMutationRun(
    workspaceMutationRunId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT run.*,
              row_to_json(plan) AS plan,
              row_to_json(evidence) AS evidence
         FROM workspace_mutation_runs run
         JOIN workspace_mutation_plans plan
           ON plan.id = run.workspace_mutation_plan_id
          AND plan.project_id = run.project_id
         LEFT JOIN workspace_mutation_evidence evidence
           ON evidence.workspace_mutation_run_id = run.id
          AND evidence.project_id = run.project_id
        WHERE run.id = $1`,
      [workspaceMutationRunId],
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  public async getProjectWorkspaceMutationStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [counts, recent] = await Promise.all([
      this.pool.query(
        `SELECT status, count(*)::int AS count
           FROM workspace_mutation_runs
          WHERE project_id = $1
          GROUP BY status
          ORDER BY status`,
        [projectId],
      ),
      this.pool.query(
        `SELECT run.id, run.status, run.started_at, run.completed_at,
                plan.repository_workspace_id, plan.operation_count,
                plan.total_content_bytes, plan.plan_hash
           FROM workspace_mutation_runs run
           JOIN workspace_mutation_plans plan
             ON plan.id = run.workspace_mutation_plan_id
            AND plan.project_id = run.project_id
          WHERE run.project_id = $1
          ORDER BY run.created_at DESC
          LIMIT 20`,
        [projectId],
      ),
    ]);
    return {
      workspaceMutationCounts: counts.rows,
      recentWorkspaceMutations: recent.rows,
    };
  }

  public async getPlatformWorkspaceMutationStatus(): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `SELECT status, count(*)::int AS count
         FROM workspace_mutation_runs
        GROUP BY status
        ORDER BY status`,
    );
    return { workspaceMutationCounts: result.rows };
  }
}
