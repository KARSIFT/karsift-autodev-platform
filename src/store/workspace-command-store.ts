import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  assertWorkspaceCommandAllowed,
  buildWorkspaceCommandPlanContent,
  hashWorkspaceCommandPlan,
  hashWorkspaceCommandPolicy,
  normalizeWorkspaceCommandPolicy,
  workspaceCommandPolicyContent,
  type WorkspaceCommandPolicySnapshot,
  type WorkspaceCommandPurpose,
} from "../domain/workspace-command.js";
import { sha256Json, type JsonValue } from "../domain/stable-json.js";
import type {
  ClaimWorkspaceCommandRunResult,
  CompleteWorkspaceCommandRunInput,
  CreateWorkspaceCommandPolicyInput,
  PrepareWorkspaceCommandInput,
  WorkspaceCommandStore,
} from "./workspace-command-types.js";
import type { Actor } from "./types.js";

interface WorkspaceCommandContextRow extends QueryResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly status: string;
  readonly state_version: number;
  readonly workspace_path: string | null;
  readonly repository_workspace_plan_id: string;
  readonly mode: "READ_ONLY" | "WRITE";
}

interface WorkspaceCommandPolicyRow extends QueryResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly policy_key: string;
  readonly version: number;
  readonly enabled: boolean;
  readonly purposes: JsonValue;
  readonly rules: JsonValue;
  readonly environment_allowlist: JsonValue;
  readonly max_timeout_ms: number;
  readonly max_output_bytes: number;
  readonly max_commands_per_workspace: number;
  readonly policy_hash: string;
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
    throw new Error(`Workspace command policy conflict: ${field} must be a string array`);
  }
  return value as string[];
}

function parsePolicy(row: WorkspaceCommandPolicyRow): WorkspaceCommandPolicySnapshot {
  if (!Array.isArray(row.rules)) {
    throw new Error("Workspace command policy conflict: rules must be an array");
  }
  const rules = row.rules.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Workspace command policy conflict: rule must be an object");
    }
    const executable = value.executable;
    const allowedArguments = value.allowedArguments;
    if (typeof executable !== "string" || !Array.isArray(allowedArguments)) {
      throw new Error("Workspace command policy conflict: invalid rule shape");
    }
    return {
      executable,
      allowedArguments: allowedArguments.map((vector) =>
        stringArray(vector as JsonValue, "allowed arguments"),
      ),
    };
  });

  return normalizeWorkspaceCommandPolicy({
    purposes: stringArray(row.purposes, "purposes") as WorkspaceCommandPurpose[],
    rules,
    environmentAllowlist: stringArray(
      row.environment_allowlist,
      "environment allowlist",
    ),
    maxTimeoutMs: row.max_timeout_ms,
    maxOutputBytes: row.max_output_bytes,
    maxCommandsPerWorkspace: row.max_commands_per_workspace,
  });
}

export class PostgresWorkspaceCommandStore implements WorkspaceCommandStore {
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

  public async createWorkspaceCommandPolicy(
    input: CreateWorkspaceCommandPolicyInput,
  ): Promise<Record<string, unknown>> {
    if (input.policyKey.trim().length === 0) {
      throw new Error("policyKey must not be empty");
    }
    if (!Number.isInteger(input.version) || input.version <= 0) {
      throw new Error("policy version must be a positive integer");
    }
    const policy = normalizeWorkspaceCommandPolicy(input.policy);
    const policyContent = workspaceCommandPolicyContent(policy);
    const policyHash = hashWorkspaceCommandPolicy(policy);

    return this.transaction(async (client) => {
      const existingResult = await client.query(
        `SELECT *
           FROM workspace_command_policies
          WHERE project_id = $1
            AND policy_key = $2
            AND version = $3`,
        [input.projectId, input.policyKey, input.version],
      );
      const existing = existingResult.rows[0] as Record<string, unknown> | undefined;
      if (existing) {
        if (
          existing.policy_hash !== policyHash ||
          existing.enabled !== input.enabled
        ) {
          throw new Error(
            "Workspace command policy conflict: immutable policy version already exists with different content",
          );
        }
        return existing;
      }

      const result = await client.query(
        `INSERT INTO workspace_command_policies(
           project_id, policy_key, version, enabled, purposes, rules,
           environment_allowlist, max_timeout_ms, max_output_bytes,
           max_commands_per_workspace, policy_content, policy_hash, created_by
         ) VALUES (
           $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb,
           $8, $9, $10, $11::jsonb, $12, $13
         )
         RETURNING *`,
        [
          input.projectId,
          input.policyKey,
          input.version,
          input.enabled,
          JSON.stringify(policy.purposes),
          JSON.stringify(
            policy.rules.map((rule) => ({
              executable: rule.executable,
              allowedArguments: rule.allowedArguments.map((vector) => [...vector]),
            })),
          ),
          JSON.stringify(policy.environmentAllowlist),
          policy.maxTimeoutMs,
          policy.maxOutputBytes,
          policy.maxCommandsPerWorkspace,
          JSON.stringify(policyContent),
          policyHash,
          input.actor.id,
        ],
      );
      const created = result.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: input.projectId,
        actor: input.actor,
        action: "WORKSPACE_COMMAND_POLICY_CREATED",
        entityType: "WORKSPACE_COMMAND_POLICY",
        entityId: String(created.id),
        data: {
          policyKey: input.policyKey,
          version: input.version,
          enabled: input.enabled,
          policyHash,
        },
      });
      return created;
    });
  }

  public async prepareWorkspaceCommand(
    input: PrepareWorkspaceCommandInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const contextResult = await client.query<WorkspaceCommandContextRow>(
        `SELECT workspace.id,
                workspace.project_id,
                workspace.status,
                workspace.state_version,
                workspace.workspace_path,
                workspace.repository_workspace_plan_id,
                plan.mode
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
          `Workspace command conflict: workspace status ${context.status} is not MATERIALIZED`,
        );
      }

      const policyResult = await client.query<WorkspaceCommandPolicyRow>(
        `SELECT *
           FROM workspace_command_policies
          WHERE project_id = $1
            AND policy_key = $2
            AND enabled = true
          ORDER BY version DESC
          LIMIT 1`,
        [context.project_id, input.policyKey],
      );
      const policyRow = policyResult.rows[0];
      if (!policyRow) {
        throw new Error(
          `Workspace command policy not found or disabled: ${input.policyKey}`,
        );
      }
      const policy = parsePolicy(policyRow);
      assertWorkspaceCommandAllowed(policy, input);

      const planInput = {
        projectId: context.project_id,
        repositoryWorkspaceId: context.id,
        repositoryWorkspacePlanId: context.repository_workspace_plan_id,
        policyId: policyRow.id,
        policyHash: policyRow.policy_hash,
        workspaceStateVersion: context.state_version,
        workspacePath: context.workspace_path,
        workspaceMode: context.mode,
        purpose: input.purpose,
        executable: input.executable,
        arguments: [...input.arguments],
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        environment: { ...input.environment },
      } as const;
      const planContent = buildWorkspaceCommandPlanContent(planInput);
      const planHash = hashWorkspaceCommandPlan(planInput);

      const existingResult = await client.query(
        `SELECT plan.*,
                row_to_json(run) AS run
           FROM workspace_command_plans plan
           JOIN workspace_command_runs run
             ON run.workspace_command_plan_id = plan.id
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
        `INSERT INTO workspace_command_plans(
           project_id, repository_workspace_id, repository_workspace_plan_id,
           workspace_command_policy_id, policy_hash, workspace_state_version,
           workspace_path, workspace_mode, purpose, executable, arguments,
           timeout_ms, max_output_bytes, environment, plan_content, plan_hash, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
           $12, $13, $14::jsonb, $15::jsonb, $16, $17
         )
         RETURNING *`,
        [
          context.project_id,
          context.id,
          context.repository_workspace_plan_id,
          policyRow.id,
          policyRow.policy_hash,
          context.state_version,
          context.workspace_path,
          context.mode,
          input.purpose,
          input.executable,
          JSON.stringify(input.arguments),
          input.timeoutMs,
          input.maxOutputBytes,
          JSON.stringify(input.environment),
          JSON.stringify(planContent),
          planHash,
          input.actor.id,
        ],
      );
      const plan = planResult.rows[0] as Record<string, unknown>;
      const runResult = await client.query(
        `INSERT INTO workspace_command_runs(project_id, workspace_command_plan_id)
         VALUES ($1, $2)
         RETURNING *`,
        [context.project_id, plan.id],
      );
      const run = runResult.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action: "WORKSPACE_COMMAND_PREPARED",
        entityType: "WORKSPACE_COMMAND_RUN",
        entityId: String(run.id),
        data: {
          repositoryWorkspaceId: context.id,
          policyId: policyRow.id,
          policyHash: policyRow.policy_hash,
          purpose: input.purpose,
          executable: input.executable,
          arguments: [...input.arguments],
          timeoutMs: input.timeoutMs,
          maxOutputBytes: input.maxOutputBytes,
          planHash,
        },
      });
      return { plan, run };
    });
  }

  public async claimWorkspaceCommandRun(
    workspaceCommandRunId: string,
    actor: Actor,
  ): Promise<ClaimWorkspaceCommandRunResult> {
    return this.transaction(async (client) => {
      const claimResult = await client.query(
        `UPDATE workspace_command_runs
            SET status = 'RUNNING',
                state_version = state_version + 1,
                started_at = now(),
                updated_at = now()
          WHERE id = $1
            AND status = 'PREPARED'
          RETURNING *`,
        [workspaceCommandRunId],
      );

      const currentResult = await client.query(
        `SELECT run.*,
                row_to_json(plan) AS plan
           FROM workspace_command_runs run
           JOIN workspace_command_plans plan
             ON plan.id = run.workspace_command_plan_id
            AND plan.project_id = run.project_id
          WHERE run.id = $1`,
        [workspaceCommandRunId],
      );
      const current = currentResult.rows[0] as Record<string, unknown> | undefined;
      if (!current) {
        throw new Error(`Workspace command run not found: ${workspaceCommandRunId}`);
      }
      const plan = current.plan as Record<string, unknown>;
      const claimed = claimResult.rowCount === 1;
      if (claimed) {
        await appendAudit(client, {
          projectId: String(current.project_id),
          actor,
          action: "WORKSPACE_COMMAND_CLAIMED",
          entityType: "WORKSPACE_COMMAND_RUN",
          entityId: workspaceCommandRunId,
          data: { planHash: String(plan.plan_hash) },
        });
      }
      return { claimed, run: current, plan };
    });
  }

  public async completeWorkspaceCommandRun(
    input: CompleteWorkspaceCommandRunInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const currentResult = await client.query(
        `SELECT run.*,
                row_to_json(plan) AS plan,
                row_to_json(evidence) AS evidence
           FROM workspace_command_runs run
           JOIN workspace_command_plans plan
             ON plan.id = run.workspace_command_plan_id
            AND plan.project_id = run.project_id
           LEFT JOIN workspace_command_evidence evidence
             ON evidence.workspace_command_run_id = run.id
            AND evidence.project_id = run.project_id
          WHERE run.id = $1
          FOR UPDATE OF run`,
        [input.workspaceCommandRunId],
      );
      const current = currentResult.rows[0] as Record<string, unknown> | undefined;
      if (!current) {
        throw new Error(`Workspace command run not found: ${input.workspaceCommandRunId}`);
      }
      if (["SUCCEEDED", "FAILED", "TIMED_OUT"].includes(String(current.status))) {
        return current;
      }
      if (current.status !== "RUNNING") {
        throw new Error(
          `Workspace command conflict: run status ${String(current.status)} cannot complete`,
        );
      }
      const plan = current.plan as Record<string, unknown>;
      const runnerResult = input.runnerResult;
      const terminalStatus = runnerResult.timedOut
        ? "TIMED_OUT"
        : runnerResult.errorCode !== null || runnerResult.exitCode !== 0
          ? "FAILED"
          : "SUCCEEDED";
      const resultContent: JsonValue = {
        workspaceCommandRunId: input.workspaceCommandRunId,
        planHash: String(plan.plan_hash),
        terminalStatus,
        exitCode: runnerResult.exitCode,
        signal: runnerResult.signal,
        timedOut: runnerResult.timedOut,
        durationMs: runnerResult.durationMs,
        stdoutSha256: runnerResult.stdoutSha256,
        stderrSha256: runnerResult.stderrSha256,
        stdoutBytes: runnerResult.stdoutBytes,
        stderrBytes: runnerResult.stderrBytes,
        stdoutTruncated: runnerResult.stdoutTruncated,
        stderrTruncated: runnerResult.stderrTruncated,
        errorCode: runnerResult.errorCode,
      };
      const resultHash = sha256Json(resultContent);

      const evidenceResult = await client.query(
        `INSERT INTO workspace_command_evidence(
           project_id, workspace_command_run_id, exit_code, signal, timed_out,
           duration_ms, stdout_sha256, stderr_sha256, stdout_bytes, stderr_bytes,
           stdout_truncated, stderr_truncated, error_code, result_hash, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
         )
         RETURNING *`,
        [
          current.project_id,
          input.workspaceCommandRunId,
          runnerResult.exitCode,
          runnerResult.signal,
          runnerResult.timedOut,
          runnerResult.durationMs,
          runnerResult.stdoutSha256,
          runnerResult.stderrSha256,
          runnerResult.stdoutBytes,
          runnerResult.stderrBytes,
          runnerResult.stdoutTruncated,
          runnerResult.stderrTruncated,
          runnerResult.errorCode,
          resultHash,
          input.actor.id,
        ],
      );
      const evidence = evidenceResult.rows[0] as Record<string, unknown>;
      const runResult = await client.query(
        `UPDATE workspace_command_runs
            SET status = $2,
                state_version = state_version + 1,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [input.workspaceCommandRunId, terminalStatus],
      );
      const run = runResult.rows[0] as Record<string, unknown>;

      await appendAudit(client, {
        projectId: String(current.project_id),
        actor: input.actor,
        action: "WORKSPACE_COMMAND_COMPLETED",
        entityType: "WORKSPACE_COMMAND_RUN",
        entityId: input.workspaceCommandRunId,
        data: {
          terminalStatus,
          resultHash,
          exitCode: runnerResult.exitCode,
          timedOut: runnerResult.timedOut,
        },
      });
      return { run, plan, evidence };
    });
  }

  public async getWorkspaceCommandRun(
    workspaceCommandRunId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT run.*,
              row_to_json(plan) AS plan,
              row_to_json(evidence) AS evidence
         FROM workspace_command_runs run
         JOIN workspace_command_plans plan
           ON plan.id = run.workspace_command_plan_id
          AND plan.project_id = run.project_id
         LEFT JOIN workspace_command_evidence evidence
           ON evidence.workspace_command_run_id = run.id
          AND evidence.project_id = run.project_id
        WHERE run.id = $1`,
      [workspaceCommandRunId],
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  public async getProjectWorkspaceCommandStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [counts, recent] = await Promise.all([
      this.pool.query(
        `SELECT status, count(*)::int AS count
           FROM workspace_command_runs
          WHERE project_id = $1
          GROUP BY status
          ORDER BY status`,
        [projectId],
      ),
      this.pool.query(
        `SELECT run.id, run.status, run.started_at, run.completed_at,
                plan.purpose, plan.executable, plan.repository_workspace_id,
                plan.plan_hash
           FROM workspace_command_runs run
           JOIN workspace_command_plans plan
             ON plan.id = run.workspace_command_plan_id
            AND plan.project_id = run.project_id
          WHERE run.project_id = $1
          ORDER BY run.created_at DESC
          LIMIT 20`,
        [projectId],
      ),
    ]);
    return {
      workspaceCommandCounts: counts.rows,
      recentWorkspaceCommands: recent.rows,
    };
  }

  public async getPlatformWorkspaceCommandStatus(): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `SELECT status, count(*)::int AS count
         FROM workspace_command_runs
        GROUP BY status
        ORDER BY status`,
    );
    return { workspaceCommandCounts: result.rows };
  }
}
