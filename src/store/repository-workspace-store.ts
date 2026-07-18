import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  buildRepositoryWorkspacePlanContent,
  evaluateWorkspaceScope,
  hashRepositoryWorkspacePlan,
  repositoryWorkspaceIdentity,
  type RepositoryWorkspaceMode,
} from "../domain/repository-workspace.js";
import { sha256Json, type JsonValue } from "../domain/stable-json.js";
import { normalizeRelevantPaths } from "../domain/task-context-pack.js";
import type {
  FinalizeRepositoryWorkspaceInput,
  MarkRepositoryWorkspaceMaterializedInput,
  PrepareRepositoryWorkspaceInput,
  RepositoryWorkspaceStore,
  TransitionRepositoryWorkspaceInput,
} from "./repository-workspace-types.js";
import type { Actor } from "./types.js";

interface WorkspacePreparationContextRow extends QueryResultRow {
  readonly builder_invocation_id: string;
  readonly project_id: string;
  readonly invocation_status: string;
  readonly execution_attempt_id: string;
  readonly task_context_pack_id: string;
  readonly task_context_pack_hash: string;
  readonly repository_full_name: string;
  readonly base_branch: string;
  readonly base_commit_sha: string;
  readonly relevant_paths: JsonValue;
  readonly automated_write_enabled: boolean;
}

interface WorkspaceRow extends QueryResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly status: string;
  readonly state_version: number;
  readonly workspace_path: string | null;
  readonly materialized_head_sha: string | null;
}

interface WorkspaceFinalizationRow extends WorkspaceRow {
  readonly base_commit_sha: string;
  readonly relevant_paths: JsonValue;
  readonly mode: RepositoryWorkspaceMode;
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
    throw new Error(`Repository workspace conflict: ${field} is not a string array`);
  }
  return value as string[];
}

export class PostgresRepositoryWorkspaceStore implements RepositoryWorkspaceStore {
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

  public async prepareRepositoryWorkspace(
    input: PrepareRepositoryWorkspaceInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const contextResult = await client.query<WorkspacePreparationContextRow>(
        `SELECT
           invocation.id AS builder_invocation_id,
           invocation.project_id,
           invocation.status AS invocation_status,
           invocation.execution_attempt_id,
           invocation_plan.task_context_pack_id,
           invocation_plan.task_context_pack_hash,
           context_pack.repository_full_name,
           context_pack.base_branch,
           context_pack.base_commit_sha,
           context_pack.content #> '{repositorySnapshot,relevantPaths}' AS relevant_paths,
           is_effective_capability_enabled(invocation.project_id, 'AUTOMATED_WRITE')
             AS automated_write_enabled
         FROM builder_invocations invocation
         JOIN builder_invocation_plans invocation_plan
           ON invocation_plan.id = invocation.builder_invocation_plan_id
          AND invocation_plan.project_id = invocation.project_id
         JOIN task_context_packs context_pack
           ON context_pack.id = invocation_plan.task_context_pack_id
          AND context_pack.project_id = invocation.project_id
         WHERE invocation.id = $1
         FOR UPDATE OF invocation`,
        [input.builderInvocationId],
      );
      const context = contextResult.rows[0];
      if (!context) {
        throw new Error(`Builder invocation not found: ${input.builderInvocationId}`);
      }
      if (context.invocation_status !== "PREPARED") {
        throw new Error(
          `Repository workspace conflict: builder invocation status ${context.invocation_status} is not PREPARED`,
        );
      }
      if (input.mode === "WRITE" && !context.automated_write_enabled) {
        throw new Error(
          "Repository workspace conflict: AUTOMATED_WRITE capability is not enabled",
        );
      }

      const relevantPaths = normalizeRelevantPaths(
        stringArray(context.relevant_paths, "relevant paths"),
      );
      const planContent = buildRepositoryWorkspacePlanContent({
        builderInvocationId: context.builder_invocation_id,
        executionAttemptId: context.execution_attempt_id,
        taskContextPackId: context.task_context_pack_id,
        taskContextPackHash: context.task_context_pack_hash,
        repositoryFullName: context.repository_full_name,
        baseBranch: context.base_branch,
        baseCommitSha: context.base_commit_sha,
        relevantPaths,
        mode: input.mode,
        adapterKey: "local-git",
      });
      const planHash = hashRepositoryWorkspacePlan(planContent);
      const identity = repositoryWorkspaceIdentity(planHash);

      const existingResult = await client.query(
        `SELECT plan.*,
                row_to_json(workspace) AS workspace
           FROM repository_workspace_plans plan
           JOIN repository_workspaces workspace
             ON workspace.repository_workspace_plan_id = plan.id
            AND workspace.project_id = plan.project_id
          WHERE plan.builder_invocation_id = $1`,
        [input.builderInvocationId],
      );
      const existing = existingResult.rows[0] as Record<string, unknown> | undefined;
      if (existing) {
        if (existing.plan_hash !== planHash) {
          throw new Error(
            "Repository workspace conflict: an immutable workspace plan already exists with different mode or evidence",
          );
        }
        return { plan: existing, workspace: existing.workspace as Record<string, unknown> };
      }

      const planResult = await client.query(
        `INSERT INTO repository_workspace_plans(
           project_id,
           builder_invocation_id,
           execution_attempt_id,
           task_context_pack_id,
           task_context_pack_hash,
           repository_full_name,
           base_branch,
           base_commit_sha,
           relevant_paths,
           mode,
           adapter_key,
           workspace_key,
           branch_name,
           plan_content,
           plan_hash,
           created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'local-git', $11, $12, $13::jsonb, $14, $15
         )
         RETURNING *`,
        [
          context.project_id,
          context.builder_invocation_id,
          context.execution_attempt_id,
          context.task_context_pack_id,
          context.task_context_pack_hash,
          context.repository_full_name,
          context.base_branch,
          context.base_commit_sha,
          JSON.stringify(relevantPaths),
          input.mode,
          identity.workspaceKey,
          identity.branchName,
          JSON.stringify(planContent),
          planHash,
          input.actor.id,
        ],
      );
      const plan = planResult.rows[0] as Record<string, unknown>;

      const workspaceResult = await client.query(
        `INSERT INTO repository_workspaces(
           project_id, repository_workspace_plan_id
         ) VALUES ($1, $2)
         RETURNING *`,
        [context.project_id, plan.id],
      );
      const workspace = workspaceResult.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action: "REPOSITORY_WORKSPACE_PREPARED",
        entityType: "REPOSITORY_WORKSPACE",
        entityId: String(workspace.id),
        data: {
          builderInvocationId: context.builder_invocation_id,
          executionAttemptId: context.execution_attempt_id,
          taskContextPackId: context.task_context_pack_id,
          taskContextPackHash: context.task_context_pack_hash,
          repositoryFullName: context.repository_full_name,
          baseBranch: context.base_branch,
          baseCommitSha: context.base_commit_sha,
          relevantPaths: [...relevantPaths],
          mode: input.mode,
          adapterKey: "local-git",
          workspaceKey: identity.workspaceKey,
          branchName: identity.branchName,
          planHash,
        },
      });

      return { plan, workspace };
    });
  }

  public async markRepositoryWorkspaceMaterialized(
    input: MarkRepositoryWorkspaceMaterializedInput,
  ): Promise<Record<string, unknown>> {
    if (input.workspacePath.trim().length === 0) {
      throw new Error("workspacePath must not be empty");
    }
    if (!/^[a-f0-9]{40,64}$/.test(input.headCommitSha)) {
      throw new Error("headCommitSha must be a lowercase 40-64 character hexadecimal SHA");
    }

    return this.transaction(async (client) => {
      const currentResult = await client.query<WorkspaceRow>(
        `SELECT *
           FROM repository_workspaces
          WHERE id = $1
          FOR UPDATE`,
        [input.repositoryWorkspaceId],
      );
      const current = currentResult.rows[0];
      if (!current) {
        throw new Error(
          `Repository workspace not found: ${input.repositoryWorkspaceId}`,
        );
      }
      if (current.status === "MATERIALIZED") {
        if (
          current.workspace_path !== input.workspacePath ||
          current.materialized_head_sha !== input.headCommitSha
        ) {
          throw new Error(
            "Repository workspace conflict: materialized workspace evidence differs",
          );
        }
        return current as unknown as Record<string, unknown>;
      }
      if (current.status !== "PREPARED") {
        throw new Error(
          `Repository workspace conflict: status ${current.status} cannot materialize`,
        );
      }

      const result = await client.query(
        `UPDATE repository_workspaces
            SET status = 'MATERIALIZED',
                state_version = state_version + 1,
                workspace_path = $2,
                materialized_head_sha = $3,
                materialized_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [input.repositoryWorkspaceId, input.workspacePath, input.headCommitSha],
      );
      const workspace = result.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: current.project_id,
        actor: input.actor,
        action: "REPOSITORY_WORKSPACE_MATERIALIZED",
        entityType: "REPOSITORY_WORKSPACE",
        entityId: input.repositoryWorkspaceId,
        data: {
          workspacePath: input.workspacePath,
          headCommitSha: input.headCommitSha,
        },
      });
      return workspace;
    });
  }

  public async finalizeRepositoryWorkspace(
    input: FinalizeRepositoryWorkspaceInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const currentResult = await client.query<WorkspaceFinalizationRow>(
        `SELECT workspace.*,
                plan.base_commit_sha,
                plan.relevant_paths,
                plan.mode
           FROM repository_workspaces workspace
           JOIN repository_workspace_plans plan
             ON plan.id = workspace.repository_workspace_plan_id
            AND plan.project_id = workspace.project_id
          WHERE workspace.id = $1
          FOR UPDATE OF workspace`,
        [input.repositoryWorkspaceId],
      );
      const current = currentResult.rows[0];
      if (!current) {
        throw new Error(
          `Repository workspace not found: ${input.repositoryWorkspaceId}`,
        );
      }
      if (current.status !== "MATERIALIZED") {
        throw new Error(
          `Repository workspace conflict: status ${current.status} cannot finalize`,
        );
      }
      if (current.materialized_head_sha !== input.headCommitSha) {
        throw new Error(
          "Repository workspace conflict: workspace HEAD changed from the materialized base",
        );
      }

      const changes = [...input.changes].sort((left, right) =>
        left.path.localeCompare(right.path),
      );
      const changedPaths = normalizeRelevantPaths(changes.map((change) => change.path));
      const relevantPaths = stringArray(current.relevant_paths, "relevant paths");
      const scope = evaluateWorkspaceScope({
        mode: current.mode,
        allowedPaths: relevantPaths,
        changedPaths,
      });
      const evidenceContent: JsonValue = {
        repositoryWorkspaceId: input.repositoryWorkspaceId,
        baseCommitSha: current.base_commit_sha,
        headCommitSha: input.headCommitSha,
        mode: current.mode,
        changedPaths: [...changedPaths],
        changes: changes.map((change) => ({
          path: change.path,
          status: change.status,
          contentHash: change.contentHash,
        })),
        scopeValid: scope.valid,
        violations: [...scope.violations],
      };
      const evidenceHash = sha256Json(evidenceContent);

      const evidenceResult = await client.query(
        `INSERT INTO repository_workspace_evidence(
           project_id,
           repository_workspace_id,
           base_commit_sha,
           head_commit_sha,
           changed_paths,
           changes,
           scope_valid,
           violations,
           evidence_hash,
           created_by
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10)
         RETURNING *`,
        [
          current.project_id,
          input.repositoryWorkspaceId,
          current.base_commit_sha,
          input.headCommitSha,
          JSON.stringify(changedPaths),
          JSON.stringify(changes),
          scope.valid,
          JSON.stringify(scope.violations),
          evidenceHash,
          input.actor.id,
        ],
      );
      const evidence = evidenceResult.rows[0] as Record<string, unknown>;
      const targetStatus = scope.valid ? "FINALIZED" : "SCOPE_VIOLATION";

      const workspaceResult = await client.query(
        `UPDATE repository_workspaces
            SET status = $2,
                state_version = state_version + 1,
                finalized_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [input.repositoryWorkspaceId, targetStatus],
      );
      const workspace = workspaceResult.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: current.project_id,
        actor: input.actor,
        action: scope.valid
          ? "REPOSITORY_WORKSPACE_FINALIZED"
          : "REPOSITORY_WORKSPACE_SCOPE_VIOLATION",
        entityType: "REPOSITORY_WORKSPACE",
        entityId: input.repositoryWorkspaceId,
        data: {
          evidenceHash,
          changedPaths: [...changedPaths],
          scopeValid: scope.valid,
          violations: [...scope.violations],
        },
      });

      return { workspace, evidence };
    });
  }

  public async abandonRepositoryWorkspace(
    input: TransitionRepositoryWorkspaceInput,
  ): Promise<Record<string, unknown>> {
    return this.transitionWorkspace(input, "ABANDONED");
  }

  public async failRepositoryWorkspace(
    input: TransitionRepositoryWorkspaceInput,
  ): Promise<Record<string, unknown>> {
    return this.transitionWorkspace(input, "FAILED");
  }

  private async transitionWorkspace(
    input: TransitionRepositoryWorkspaceInput,
    targetStatus: "ABANDONED" | "FAILED",
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const currentResult = await client.query<WorkspaceRow>(
        `SELECT * FROM repository_workspaces WHERE id = $1 FOR UPDATE`,
        [input.repositoryWorkspaceId],
      );
      const current = currentResult.rows[0];
      if (!current) {
        throw new Error(
          `Repository workspace not found: ${input.repositoryWorkspaceId}`,
        );
      }
      if (current.status === targetStatus) {
        return current as unknown as Record<string, unknown>;
      }
      if (!new Set(["PREPARED", "MATERIALIZED"]).has(current.status)) {
        throw new Error(
          `Repository workspace conflict: status ${current.status} cannot transition to ${targetStatus}`,
        );
      }

      const result = await client.query(
        `UPDATE repository_workspaces
            SET status = $2,
                state_version = state_version + 1,
                finalized_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [input.repositoryWorkspaceId, targetStatus],
      );
      const workspace = result.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: current.project_id,
        actor: input.actor,
        action: `REPOSITORY_WORKSPACE_${targetStatus}`,
        entityType: "REPOSITORY_WORKSPACE",
        entityId: input.repositoryWorkspaceId,
      });
      return workspace;
    });
  }

  public async getRepositoryWorkspace(
    repositoryWorkspaceId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT workspace.*,
              row_to_json(plan) AS plan,
              row_to_json(evidence) AS evidence
         FROM repository_workspaces workspace
         JOIN repository_workspace_plans plan
           ON plan.id = workspace.repository_workspace_plan_id
          AND plan.project_id = workspace.project_id
         LEFT JOIN repository_workspace_evidence evidence
           ON evidence.repository_workspace_id = workspace.id
          AND evidence.project_id = workspace.project_id
        WHERE workspace.id = $1`,
      [repositoryWorkspaceId],
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  public async getProjectRepositoryWorkspaceStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [counts, recent] = await Promise.all([
      this.pool.query(
        `SELECT status, count(*)::text AS count
           FROM repository_workspaces
          WHERE project_id = $1
          GROUP BY status
          ORDER BY status`,
        [projectId],
      ),
      this.pool.query(
        `SELECT workspace.id,
                workspace.status,
                workspace.state_version,
                plan.builder_invocation_id,
                plan.repository_full_name,
                plan.base_commit_sha,
                plan.mode,
                plan.workspace_key,
                plan.plan_hash,
                workspace.materialized_at,
                workspace.finalized_at,
                workspace.created_at
           FROM repository_workspaces workspace
           JOIN repository_workspace_plans plan
             ON plan.id = workspace.repository_workspace_plan_id
            AND plan.project_id = workspace.project_id
          WHERE workspace.project_id = $1
          ORDER BY workspace.created_at DESC, workspace.id DESC
          LIMIT 20`,
        [projectId],
      ),
    ]);
    return {
      repositoryWorkspaceCounts: counts.rows,
      recentRepositoryWorkspaces: recent.rows,
    };
  }

  public async getPlatformRepositoryWorkspaceStatus(): Promise<
    Record<string, unknown>
  > {
    const counts = await this.pool.query(
      `SELECT status, count(*)::text AS count
         FROM repository_workspaces
        GROUP BY status
        ORDER BY status`,
    );
    return { repositoryWorkspaceCounts: counts.rows };
  }
}
