import type { Pool, PoolClient, QueryResultRow } from "pg";

import { assertCapabilityEnablementAllowed } from "../domain/capabilities.js";
import { sha256Json, type JsonValue } from "../domain/stable-json.js";
import {
  assertWorkflowTransition,
  isTerminalWorkflowStatus,
  type WorkflowStatus,
} from "../domain/workflow-state.js";
import type {
  Actor,
  AppendChangeContractVersionInput,
  CreateChangeContractInput,
  CreateDecisionInput,
  CreateFounderRequestInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateWorkflowRunInput,
  DisableCapabilityInput,
  TransitionWorkflowRunInput,
  ControlPlaneStore,
} from "./types.js";

interface WorkflowRow extends QueryResultRow {
  readonly id: string;
  readonly project_id: string;
  readonly status: WorkflowStatus;
  readonly state_version: number;
}

function actorData(actor: Actor): readonly [Actor["type"], string] {
  return [actor.type, actor.id];
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
  const [actorType, actorId] = actorData(params.actor);
  await client.query(
    `INSERT INTO audit_events(
      project_id, actor_type, actor_id, action, entity_type, entity_id, data
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      params.projectId,
      actorType,
      actorId,
      params.action,
      params.entityType,
      params.entityId,
      JSON.stringify(params.data ?? {}),
    ],
  );
}

export class PostgresControlPlaneStore implements ControlPlaneStore {
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

  public async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  public async createProject(
    input: CreateProjectInput,
    actor: Actor,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO projects(
          slug, name, repository_full_name, default_branch, integration_branch
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [
          input.slug,
          input.name,
          input.repositoryFullName,
          input.defaultBranch,
          input.integrationBranch,
        ],
      );

      const project = result.rows[0] as Record<string, unknown>;
      const projectId = String(project.id);

      await appendAudit(client, {
        projectId,
        actor,
        action: "PROJECT_CREATED",
        entityType: "PROJECT",
        entityId: projectId,
        data: { slug: input.slug, repositoryFullName: input.repositoryFullName },
      });

      return project;
    });
  }

  public async createFounderRequest(
    input: CreateFounderRequestInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO founder_requests(
          project_id, title, body, authority_context, created_by
        ) VALUES ($1, $2, $3, $4::jsonb, $5)
        RETURNING *`,
        [
          input.projectId,
          input.title,
          input.body,
          JSON.stringify(input.authorityContext),
          input.actor.id,
        ],
      );

      const request = result.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: input.projectId,
        actor: input.actor,
        action: "FOUNDER_REQUEST_CREATED",
        entityType: "FOUNDER_REQUEST",
        entityId: String(request.id),
        data: { title: input.title },
      });

      return request;
    });
  }

  public async createDecision(
    input: CreateDecisionInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO decisions(
          project_id, request_id, decision_type, summary, rationale,
          authority_level, decided_by, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        RETURNING *`,
        [
          input.projectId,
          input.requestId,
          input.decisionType,
          input.summary,
          input.rationale,
          input.authorityLevel,
          input.actor.id,
          JSON.stringify(input.metadata),
        ],
      );

      const decision = result.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: input.projectId,
        actor: input.actor,
        action: "DECISION_RECORDED",
        entityType: "DECISION",
        entityId: String(decision.id),
        data: { authorityLevel: input.authorityLevel },
      });

      return decision;
    });
  }

  public async createChangeContract(
    input: CreateChangeContractInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const contractResult = await client.query(
        `INSERT INTO change_contracts(project_id, stable_id)
         VALUES ($1, $2)
         RETURNING *`,
        [input.projectId, input.stableId],
      );

      const contract = contractResult.rows[0] as Record<string, unknown>;
      const contractId = String(contract.id);
      const contentHash = sha256Json(input.content);

      const versionResult = await client.query(
        `INSERT INTO change_contract_versions(
          contract_id, project_id, version, content, content_hash, created_by
        ) VALUES ($1, $2, 1, $3::jsonb, $4, $5)
        RETURNING *`,
        [
          contractId,
          input.projectId,
          JSON.stringify(input.content),
          contentHash,
          input.actor.id,
        ],
      );

      await client.query(
        `UPDATE change_contracts
         SET current_version = 1, updated_at = now()
         WHERE id = $1`,
        [contractId],
      );

      const version = versionResult.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: input.projectId,
        actor: input.actor,
        action: "CHANGE_CONTRACT_CREATED",
        entityType: "CHANGE_CONTRACT",
        entityId: contractId,
        data: { stableId: input.stableId, version: 1, contentHash },
      });

      return { contract, version };
    });
  }

  public async appendChangeContractVersion(
    input: AppendChangeContractVersionInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const contractResult = await client.query<{
        id: string;
        project_id: string;
        current_version: number;
      }>(
        `SELECT id, project_id, current_version
         FROM change_contracts
         WHERE id = $1
         FOR UPDATE`,
        [input.contractId],
      );

      const contract = contractResult.rows[0];
      if (!contract) {
        throw new Error(`Change contract not found: ${input.contractId}`);
      }

      const nextVersion = contract.current_version + 1;
      const contentHash = sha256Json(input.content);

      const versionResult = await client.query(
        `INSERT INTO change_contract_versions(
          contract_id, project_id, version, content, content_hash, created_by
        ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        RETURNING *`,
        [
          input.contractId,
          contract.project_id,
          nextVersion,
          JSON.stringify(input.content),
          contentHash,
          input.actor.id,
        ],
      );

      await client.query(
        `UPDATE change_contracts
         SET current_version = $2, updated_at = now()
         WHERE id = $1`,
        [input.contractId, nextVersion],
      );

      await appendAudit(client, {
        projectId: contract.project_id,
        actor: input.actor,
        action: "CHANGE_CONTRACT_VERSION_APPENDED",
        entityType: "CHANGE_CONTRACT",
        entityId: input.contractId,
        data: { version: nextVersion, contentHash },
      });

      return versionResult.rows[0] as Record<string, unknown>;
    });
  }

  public async createTask(
    input: CreateTaskInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO tasks(
          project_id, change_contract_version_id, title, description, priority
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *`,
        [
          input.projectId,
          input.changeContractVersionId,
          input.title,
          input.description,
          input.priority,
        ],
      );

      const task = result.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: input.projectId,
        actor: input.actor,
        action: "TASK_CREATED",
        entityType: "TASK",
        entityId: String(task.id),
        data: { priority: input.priority },
      });

      return task;
    });
  }

  public async createWorkflowRun(
    input: CreateWorkflowRunInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO workflow_runs(
          project_id, task_id, workflow_type, metadata
        ) VALUES ($1, $2, $3, $4::jsonb)
        RETURNING *`,
        [
          input.projectId,
          input.taskId,
          input.workflowType,
          JSON.stringify(input.metadata),
        ],
      );

      const workflowRun = result.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: input.projectId,
        actor: input.actor,
        action: "WORKFLOW_RUN_CREATED",
        entityType: "WORKFLOW_RUN",
        entityId: String(workflowRun.id),
        data: { workflowType: input.workflowType },
      });

      return workflowRun;
    });
  }

  public async transitionWorkflowRun(
    input: TransitionWorkflowRunInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const currentResult = await client.query<WorkflowRow>(
        `SELECT id, project_id, status, state_version
         FROM workflow_runs
         WHERE id = $1
         FOR UPDATE`,
        [input.workflowRunId],
      );

      const current = currentResult.rows[0];
      if (!current) {
        throw new Error(`Workflow run not found: ${input.workflowRunId}`);
      }

      if (current.state_version !== input.expectedStateVersion) {
        throw new Error(
          `Workflow state version conflict: expected ${input.expectedStateVersion}, current ${current.state_version}`,
        );
      }

      assertWorkflowTransition(current.status, input.targetStatus);

      const startedAtClause =
        current.status === "CREATED" && input.targetStatus === "RUNNING"
          ? "started_at = COALESCE(started_at, now()),"
          : "";

      const completedAtClause = isTerminalWorkflowStatus(input.targetStatus)
        ? "completed_at = now(),"
        : "";

      const updateResult = await client.query(
        `UPDATE workflow_runs
         SET status = $2,
             ${startedAtClause}
             ${completedAtClause}
             state_version = state_version + 1,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [input.workflowRunId, input.targetStatus],
      );

      await appendAudit(client, {
        projectId: current.project_id,
        actor: input.actor,
        action: "WORKFLOW_RUN_TRANSITIONED",
        entityType: "WORKFLOW_RUN",
        entityId: input.workflowRunId,
        data: {
          from: current.status,
          to: input.targetStatus,
          previousStateVersion: current.state_version,
        },
      });

      return updateResult.rows[0] as Record<string, unknown>;
    });
  }

  public async listCapabilities(
    projectId: string | null,
  ): Promise<readonly Record<string, unknown>[]> {
    const result = await this.pool.query(
      `SELECT *
       FROM capability_switches
       WHERE (scope_type = 'GLOBAL' AND project_id IS NULL)
          OR (scope_type = 'PROJECT' AND project_id = $1)
       ORDER BY scope_type, capability`,
      [projectId],
    );
    return result.rows as readonly Record<string, unknown>[];
  }

  public async disableCapability(
    input: DisableCapabilityInput,
  ): Promise<Record<string, unknown>> {
    assertCapabilityEnablementAllowed(input.capability, false);

    return this.transaction(async (client) => {
      const scopeType = input.projectId === null ? "GLOBAL" : "PROJECT";
      const existing = await client.query(
        `SELECT id
         FROM capability_switches
         WHERE scope_type = $1
           AND project_id IS NOT DISTINCT FROM $2::uuid
           AND capability = $3
         FOR UPDATE`,
        [scopeType, input.projectId, input.capability],
      );

      const result =
        (existing.rowCount ?? 0) > 0
          ? await client.query(
              `UPDATE capability_switches
               SET enabled = false,
                   reason = $2,
                   updated_by = $3,
                   updated_at = now()
               WHERE id = $1
               RETURNING *`,
              [
                (existing.rows[0] as { id: string }).id,
                input.reason,
                input.actor.id,
              ],
            )
          : await client.query(
              `INSERT INTO capability_switches(
                scope_type, project_id, capability, enabled, reason, updated_by
              ) VALUES ($1, $2, $3, false, $4, $5)
              RETURNING *`,
              [
                scopeType,
                input.projectId,
                input.capability,
                input.reason,
                input.actor.id,
              ],
            );

      const switchRow = result.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: input.projectId,
        actor: input.actor,
        action: "CAPABILITY_DISABLED",
        entityType: "CAPABILITY_SWITCH",
        entityId: String(switchRow.id),
        data: { capability: input.capability, scopeType },
      });

      return switchRow;
    });
  }

  public async getProjectStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [projectResult, countsResult, workflowResult, capabilities] =
      await Promise.all([
        this.pool.query("SELECT * FROM projects WHERE id = $1", [projectId]),
        this.pool.query<{
          requests: string;
          decisions: string;
          contracts: string;
          tasks: string;
        }>(
          `SELECT
            (SELECT count(*) FROM founder_requests WHERE project_id = $1)::text AS requests,
            (SELECT count(*) FROM decisions WHERE project_id = $1)::text AS decisions,
            (SELECT count(*) FROM change_contracts WHERE project_id = $1)::text AS contracts,
            (SELECT count(*) FROM tasks WHERE project_id = $1)::text AS tasks`,
          [projectId],
        ),
        this.pool.query(
          `SELECT *
           FROM workflow_runs
           WHERE project_id = $1
           ORDER BY created_at DESC
           LIMIT 20`,
          [projectId],
        ),
        this.listCapabilities(projectId),
      ]);

    const project = projectResult.rows[0] as Record<string, unknown> | undefined;
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    return {
      project,
      counts: countsResult.rows[0] ?? {},
      recentWorkflowRuns: workflowResult.rows,
      capabilities,
    };
  }

  public async getPlatformStatus(): Promise<Record<string, unknown>> {
    const [projects, workflows, capabilities] = await Promise.all([
      this.pool.query(
        `SELECT id, slug, name, repository_full_name, status
         FROM projects
         ORDER BY created_at`,
      ),
      this.pool.query(
        `SELECT status, count(*)::text AS count
         FROM workflow_runs
         GROUP BY status
         ORDER BY status`,
      ),
      this.listCapabilities(null),
    ]);

    return {
      activationLevel: "A1",
      workerDispatchActive: false,
      projects: projects.rows,
      workflowCounts: workflows.rows,
      capabilities,
    };
  }
}
