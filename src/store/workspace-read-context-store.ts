import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  buildWorkspaceReadContextRequestContent,
  buildWorkspaceReadContextSnapshotContent,
  hashWorkspaceReadContextRequest,
  hashWorkspaceReadContextSnapshot,
  normalizeWorkspaceReadContextFiles,
  normalizeWorkspaceReadContextRequestedPaths,
} from "../domain/workspace-read-context.js";
import type { JsonValue } from "../domain/stable-json.js";
import type {
  ClaimWorkspaceReadContextRunResult,
  CompleteWorkspaceReadContextInput,
  FailWorkspaceReadContextInput,
  PrepareWorkspaceReadContextInput,
  WorkspaceReadContextStore,
} from "./workspace-read-context-types.js";
import type { Actor } from "./types.js";

interface WorkspaceReadContextRow extends QueryResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly status: string;
  readonly state_version: number;
  readonly workspace_path: string | null;
  readonly repository_workspace_plan_id: string;
  readonly builder_invocation_id: string;
  readonly task_context_pack_id: string;
  readonly task_context_pack_hash: string;
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
    throw new Error(`Workspace read context conflict: ${field} must be a string array`);
  }
  return value as string[];
}

export class PostgresWorkspaceReadContextStore implements WorkspaceReadContextStore {
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

  public async prepareWorkspaceReadContext(
    input: PrepareWorkspaceReadContextInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const contextResult = await client.query<WorkspaceReadContextRow>(
        `SELECT workspace.id,
                workspace.project_id,
                workspace.status,
                workspace.state_version,
                workspace.workspace_path,
                workspace.repository_workspace_plan_id,
                plan.builder_invocation_id,
                plan.task_context_pack_id,
                plan.task_context_pack_hash,
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
          `Workspace read context conflict: workspace status ${context.status} is not MATERIALIZED`,
        );
      }

      const relevantPaths = stringArray(context.relevant_paths, "relevant paths");
      const requestedPaths = normalizeWorkspaceReadContextRequestedPaths(
        input.requestedPaths,
        relevantPaths,
      );
      const requestInput = {
        projectId: context.project_id,
        repositoryWorkspaceId: context.id,
        repositoryWorkspacePlanId: context.repository_workspace_plan_id,
        builderInvocationId: context.builder_invocation_id,
        taskContextPackId: context.task_context_pack_id,
        taskContextPackHash: context.task_context_pack_hash,
        workspaceStateVersion: context.state_version,
        workspacePath: context.workspace_path,
        relevantPaths,
        requestedPaths,
      } as const;
      const requestContent = buildWorkspaceReadContextRequestContent(requestInput);
      const requestHash = hashWorkspaceReadContextRequest(requestInput);

      const existingResult = await client.query(
        `SELECT request.*,
                row_to_json(run) AS run,
                row_to_json(snapshot) AS snapshot
           FROM workspace_read_context_requests request
           JOIN workspace_read_context_runs run
             ON run.workspace_read_context_request_id = request.id
            AND run.project_id = request.project_id
           LEFT JOIN workspace_read_context_snapshots snapshot
             ON snapshot.workspace_read_context_run_id = run.id
            AND snapshot.project_id = run.project_id
          WHERE request.project_id = $1
            AND request.request_hash = $2`,
        [context.project_id, requestHash],
      );
      const existing = existingResult.rows[0] as Record<string, unknown> | undefined;
      if (existing) {
        return {
          request: existing,
          run: existing.run as Record<string, unknown>,
          snapshot: (existing.snapshot as Record<string, unknown> | null) ?? null,
        };
      }

      const requestResult = await client.query(
        `INSERT INTO workspace_read_context_requests(
           project_id, repository_workspace_id, repository_workspace_plan_id,
           builder_invocation_id, task_context_pack_id, task_context_pack_hash,
           workspace_state_version, workspace_path, relevant_paths, requested_paths,
           request_content, request_hash, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
           $11::jsonb, $12, $13
         )
         RETURNING *`,
        [
          context.project_id,
          context.id,
          context.repository_workspace_plan_id,
          context.builder_invocation_id,
          context.task_context_pack_id,
          context.task_context_pack_hash,
          context.state_version,
          context.workspace_path,
          JSON.stringify(relevantPaths),
          JSON.stringify(requestedPaths),
          JSON.stringify(requestContent),
          requestHash,
          input.actor.id,
        ],
      );
      const request = requestResult.rows[0] as Record<string, unknown>;
      const runResult = await client.query(
        `INSERT INTO workspace_read_context_runs(
           project_id, repository_workspace_id, workspace_read_context_request_id
         ) VALUES ($1, $2, $3)
         RETURNING *`,
        [context.project_id, context.id, request.id],
      );
      const run = runResult.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action: "WORKSPACE_READ_CONTEXT_PREPARED",
        entityType: "WORKSPACE_READ_CONTEXT_RUN",
        entityId: String(run.id),
        data: { requestHash, requestedPaths: [...requestedPaths] },
      });
      return { request, run, snapshot: null };
    });
  }

  public async claimWorkspaceReadContextRun(
    workspaceReadContextRunId: string,
    actor: Actor,
  ): Promise<ClaimWorkspaceReadContextRunResult> {
    try {
      return await this.transaction(async (client) => {
        const claimResult = await client.query(
          `UPDATE workspace_read_context_runs
              SET status = 'CAPTURING',
                  state_version = state_version + 1,
                  started_at = now(),
                  updated_at = now()
            WHERE id = $1
              AND status = 'PREPARED'
            RETURNING *`,
          [workspaceReadContextRunId],
        );
        const currentResult = await client.query(
          `SELECT run.*,
                  row_to_json(request) AS request,
                  row_to_json(snapshot) AS snapshot
             FROM workspace_read_context_runs run
             JOIN workspace_read_context_requests request
               ON request.id = run.workspace_read_context_request_id
              AND request.project_id = run.project_id
             LEFT JOIN workspace_read_context_snapshots snapshot
               ON snapshot.workspace_read_context_run_id = run.id
              AND snapshot.project_id = run.project_id
            WHERE run.id = $1`,
          [workspaceReadContextRunId],
        );
        const current = currentResult.rows[0] as Record<string, unknown> | undefined;
        if (!current) {
          throw new Error(`Workspace read context run not found: ${workspaceReadContextRunId}`);
        }
        const request = current.request as Record<string, unknown>;
        const claimed = claimResult.rowCount === 1;
        if (claimed) {
          await appendAudit(client, {
            projectId: String(current.project_id),
            actor,
            action: "WORKSPACE_READ_CONTEXT_CLAIMED",
            entityType: "WORKSPACE_READ_CONTEXT_RUN",
            entityId: workspaceReadContextRunId,
            data: { requestHash: String(request.request_hash) },
          });
        }
        return { claimed, run: current, request };
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const current = await this.getWorkspaceReadContextRun(workspaceReadContextRunId);
        if (!current) {
          throw new Error(`Workspace read context run not found: ${workspaceReadContextRunId}`);
        }
        return {
          claimed: false,
          run: current,
          request: current.request as Record<string, unknown>,
        };
      }
      throw error;
    }
  }

  public async completeWorkspaceReadContext(
    input: CompleteWorkspaceReadContextInput,
  ): Promise<Record<string, unknown>> {
    const files = normalizeWorkspaceReadContextFiles(input.files);
    return this.transaction(async (client) => {
      const currentResult = await client.query(
        `SELECT run.*,
                row_to_json(request) AS request,
                row_to_json(snapshot) AS snapshot
           FROM workspace_read_context_runs run
           JOIN workspace_read_context_requests request
             ON request.id = run.workspace_read_context_request_id
            AND request.project_id = run.project_id
           LEFT JOIN workspace_read_context_snapshots snapshot
             ON snapshot.workspace_read_context_run_id = run.id
            AND snapshot.project_id = run.project_id
          WHERE run.id = $1
          FOR UPDATE OF run`,
        [input.workspaceReadContextRunId],
      );
      const current = currentResult.rows[0] as Record<string, unknown> | undefined;
      if (!current) {
        throw new Error(`Workspace read context run not found: ${input.workspaceReadContextRunId}`);
      }
      if (current.status === "CAPTURED") {
        return current;
      }
      if (current.status !== "CAPTURING") {
        throw new Error(
          `Workspace read context conflict: run status ${String(current.status)} cannot complete`,
        );
      }
      const request = current.request as Record<string, unknown>;
      const snapshotInput = {
        projectId: String(request.project_id),
        repositoryWorkspaceId: String(request.repository_workspace_id),
        repositoryWorkspacePlanId: String(request.repository_workspace_plan_id),
        builderInvocationId: String(request.builder_invocation_id),
        taskContextPackId: String(request.task_context_pack_id),
        taskContextPackHash: String(request.task_context_pack_hash),
        workspaceStateVersion: Number(request.workspace_state_version),
        workspacePath: String(request.workspace_path),
        relevantPaths: stringArray(request.relevant_paths as JsonValue, "relevant paths"),
        requestedPaths: stringArray(request.requested_paths as JsonValue, "requested paths"),
        requestHash: String(request.request_hash),
        files,
      };
      const snapshotContent = buildWorkspaceReadContextSnapshotContent(snapshotInput);
      const snapshotHash = hashWorkspaceReadContextSnapshot(snapshotInput);
      const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);

      const snapshotResult = await client.query(
        `INSERT INTO workspace_read_context_snapshots(
           project_id, workspace_read_context_run_id, request_hash,
           file_count, total_bytes, files, snapshot_content, snapshot_hash, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
         RETURNING *`,
        [
          current.project_id,
          input.workspaceReadContextRunId,
          request.request_hash,
          files.length,
          totalBytes,
          JSON.stringify(files),
          JSON.stringify(snapshotContent),
          snapshotHash,
          input.actor.id,
        ],
      );
      const snapshot = snapshotResult.rows[0] as Record<string, unknown>;
      const runResult = await client.query(
        `UPDATE workspace_read_context_runs
            SET status = 'CAPTURED',
                state_version = state_version + 1,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [input.workspaceReadContextRunId],
      );
      const run = runResult.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: String(current.project_id),
        actor: input.actor,
        action: "WORKSPACE_READ_CONTEXT_CAPTURED",
        entityType: "WORKSPACE_READ_CONTEXT_RUN",
        entityId: input.workspaceReadContextRunId,
        data: { snapshotHash, fileCount: files.length, totalBytes },
      });
      return { run, request, snapshot };
    });
  }

  public async failWorkspaceReadContext(
    input: FailWorkspaceReadContextInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE workspace_read_context_runs
            SET status = 'FAILED',
                state_version = state_version + 1,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1
            AND status = 'CAPTURING'
          RETURNING *`,
        [input.workspaceReadContextRunId],
      );
      const run = result.rows[0] as Record<string, unknown> | undefined;
      if (!run) {
        const current = await this.getWorkspaceReadContextRun(input.workspaceReadContextRunId);
        if (!current) {
          throw new Error(`Workspace read context run not found: ${input.workspaceReadContextRunId}`);
        }
        return current;
      }
      await appendAudit(client, {
        projectId: String(run.project_id),
        actor: input.actor,
        action: "WORKSPACE_READ_CONTEXT_FAILED",
        entityType: "WORKSPACE_READ_CONTEXT_RUN",
        entityId: input.workspaceReadContextRunId,
      });
      return run;
    });
  }

  public async getWorkspaceReadContextRun(
    workspaceReadContextRunId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT run.*,
              row_to_json(request) AS request,
              row_to_json(snapshot) AS snapshot
         FROM workspace_read_context_runs run
         JOIN workspace_read_context_requests request
           ON request.id = run.workspace_read_context_request_id
          AND request.project_id = run.project_id
         LEFT JOIN workspace_read_context_snapshots snapshot
           ON snapshot.workspace_read_context_run_id = run.id
          AND snapshot.project_id = run.project_id
        WHERE run.id = $1`,
      [workspaceReadContextRunId],
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  public async getProjectWorkspaceReadContextStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [counts, recent] = await Promise.all([
      this.pool.query(
        `SELECT status, count(*)::int AS count
           FROM workspace_read_context_runs
          WHERE project_id = $1
          GROUP BY status
          ORDER BY status`,
        [projectId],
      ),
      this.pool.query(
        `SELECT run.id, run.status, run.started_at, run.completed_at,
                request.repository_workspace_id, request.request_hash,
                snapshot.snapshot_hash, snapshot.file_count, snapshot.total_bytes
           FROM workspace_read_context_runs run
           JOIN workspace_read_context_requests request
             ON request.id = run.workspace_read_context_request_id
            AND request.project_id = run.project_id
           LEFT JOIN workspace_read_context_snapshots snapshot
             ON snapshot.workspace_read_context_run_id = run.id
            AND snapshot.project_id = run.project_id
          WHERE run.project_id = $1
          ORDER BY run.created_at DESC
          LIMIT 20`,
        [projectId],
      ),
    ]);
    return {
      workspaceReadContextCounts: counts.rows,
      recentWorkspaceReadContexts: recent.rows,
    };
  }

  public async getPlatformWorkspaceReadContextStatus(): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `SELECT status, count(*)::int AS count
         FROM workspace_read_context_runs
        GROUP BY status
        ORDER BY status`,
    );
    return { workspaceReadContextCounts: result.rows };
  }
}
