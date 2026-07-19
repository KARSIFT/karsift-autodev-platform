import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  buildBuilderProposalActionDecisionContent,
  buildBuilderProposalActionResultContent,
  hashBuilderProposalActionDecision,
  hashBuilderProposalActionResult,
  normalizeBuilderProposalActionEntities,
  type BuilderProposalActionMaterializedEntity,
} from "../domain/builder-proposal-action.js";
import type { BuilderProposal, BuilderProposalAction } from "../domain/builder-proposal.js";
import type { JsonValue } from "../domain/stable-json.js";
import type {
  BuilderProposalActionStore,
  MarkBuilderProposalActionMaterializedInput,
  PrepareBuilderProposalActionInput,
  RefreshBuilderProposalActionInput,
} from "./builder-proposal-action-types.js";
import type { Actor } from "./types.js";

interface ActionContextRow extends QueryResultRow {
  readonly project_id: string;
  readonly builder_invocation_id: string;
  readonly builder_proposal_request_id: string;
  readonly builder_proposal_run_id: string;
  readonly builder_proposal_evidence_id: string;
  readonly proposal_action: BuilderProposalAction;
  readonly proposal_content: JsonValue;
  readonly proposal_hash: string;
  readonly task_context_pack_id: string;
  readonly task_context_pack_hash: string;
  readonly repository_workspace_id: string;
  readonly workspace_state_version: number;
  readonly turn_number: number;
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

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Builder proposal action conflict: ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function jsonArray(value: unknown, field: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`Builder proposal action conflict: ${field} must be an array`);
  }
  return value as JsonValue[];
}

function proposalFromJson(value: JsonValue): BuilderProposal {
  const record = recordValue(value, "proposal content");
  const action = String(record.action) as BuilderProposalAction;
  return {
    action,
    summary: String(record.summary ?? ""),
    requestedPaths: jsonArray(record.requestedPaths, "requestedPaths").map(String),
    commands: jsonArray(record.commands, "commands").map((command) => {
      const commandRecord = recordValue(command, "command");
      return {
        purpose: String(commandRecord.purpose) as never,
        executable: String(commandRecord.executable),
        arguments: jsonArray(commandRecord.arguments, "command arguments").map(String),
      };
    }),
    mutations: jsonArray(record.mutations, "mutations").map((mutation) =>
      recordValue(mutation, "mutation") as never,
    ),
    blockingReason:
      record.blockingReason === null || record.blockingReason === undefined
        ? null
        : String(record.blockingReason),
  };
}

function entitiesJson(
  entities: readonly BuilderProposalActionMaterializedEntity[],
): JsonValue {
  return normalizeBuilderProposalActionEntities(entities).map((entity) => ({ ...entity }));
}

export class PostgresBuilderProposalActionStore implements BuilderProposalActionStore {
  public constructor(private readonly pool: Pool) {}

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
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

  private async hydrateRun(
    client: PoolClient,
    builderProposalActionRunId: string,
    lock = false,
  ): Promise<Record<string, unknown> | null> {
    const result = await client.query(
      `SELECT action_run.*,
              row_to_json(decision) AS decision,
              row_to_json(action_evidence) AS evidence
         FROM builder_proposal_action_runs action_run
         JOIN builder_proposal_action_decisions decision
           ON decision.id = action_run.builder_proposal_action_decision_id
          AND decision.project_id = action_run.project_id
         LEFT JOIN builder_proposal_action_evidence action_evidence
           ON action_evidence.builder_proposal_action_run_id = action_run.id
          AND action_evidence.project_id = action_run.project_id
        WHERE action_run.id = $1
        ${lock ? "FOR UPDATE OF action_run" : ""}`,
      [builderProposalActionRunId],
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  public async prepareBuilderProposalAction(
    input: PrepareBuilderProposalActionInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const contextResult = await client.query<ActionContextRow>(
        `SELECT request.project_id,
                request.builder_invocation_id,
                request.id AS builder_proposal_request_id,
                proposal_run.id AS builder_proposal_run_id,
                proposal_evidence.id AS builder_proposal_evidence_id,
                proposal_evidence.proposal_action,
                proposal_evidence.proposal_content,
                proposal_evidence.proposal_hash,
                request.task_context_pack_id,
                request.task_context_pack_hash,
                workspace.id AS repository_workspace_id,
                workspace.state_version AS workspace_state_version,
                (
                  SELECT count(*)::integer
                    FROM builder_proposal_requests request_count
                   WHERE request_count.project_id = request.project_id
                     AND request_count.builder_invocation_id = request.builder_invocation_id
                ) AS turn_number
           FROM builder_proposal_runs proposal_run
           JOIN builder_proposal_requests request
             ON request.id = proposal_run.builder_proposal_request_id
            AND request.project_id = proposal_run.project_id
           JOIN builder_proposal_evidence proposal_evidence
             ON proposal_evidence.builder_proposal_run_id = proposal_run.id
            AND proposal_evidence.project_id = proposal_run.project_id
           JOIN workspace_read_context_snapshots snapshot
             ON snapshot.id = request.workspace_read_context_snapshot_id
            AND snapshot.project_id = request.project_id
           JOIN workspace_read_context_runs capture_run
             ON capture_run.id = snapshot.workspace_read_context_run_id
            AND capture_run.project_id = snapshot.project_id
           JOIN workspace_read_context_requests capture_request
             ON capture_request.id = capture_run.workspace_read_context_request_id
            AND capture_request.project_id = capture_run.project_id
           JOIN repository_workspaces workspace
             ON workspace.id = capture_request.repository_workspace_id
            AND workspace.project_id = capture_request.project_id
          WHERE proposal_run.id = $1
            AND proposal_run.status = 'GENERATED'
            AND proposal_evidence.outcome = 'GENERATED'
          FOR UPDATE OF proposal_run`,
        [input.builderProposalRunId],
      );
      const context = contextResult.rows[0];
      if (!context) {
        throw new Error(
          "Builder proposal action conflict: generated proposal context was not found",
        );
      }

      const existingResult = await client.query(
        `SELECT decision.*,
                row_to_json(action_run) AS run,
                row_to_json(action_evidence) AS evidence
           FROM builder_proposal_action_decisions decision
           JOIN builder_proposal_action_runs action_run
             ON action_run.builder_proposal_action_decision_id = decision.id
            AND action_run.project_id = decision.project_id
           LEFT JOIN builder_proposal_action_evidence action_evidence
             ON action_evidence.builder_proposal_action_run_id = action_run.id
            AND action_evidence.project_id = action_run.project_id
          WHERE decision.builder_proposal_evidence_id = $1`,
        [context.builder_proposal_evidence_id],
      );
      const existing = existingResult.rows[0] as Record<string, unknown> | undefined;
      if (existing) {
        return {
          decision: existing,
          run: existing.run as Record<string, unknown>,
          evidence: (existing.evidence as Record<string, unknown> | null) ?? null,
          proposal: proposalFromJson(context.proposal_content),
          commandPolicy: await this.commandPolicyForDecision(
            client,
            context.project_id,
            existing.command_policy_id,
          ),
        };
      }

      let commandPolicy: Record<string, unknown> | null = null;
      if (context.proposal_action === "REQUEST_COMMANDS") {
        if (!input.commandPolicyKey || input.commandPolicyKey.trim().length === 0) {
          throw new Error("commandPolicyKey is required for REQUEST_COMMANDS proposals");
        }
        const policyResult = await client.query(
          `SELECT *
             FROM workspace_command_policies
            WHERE project_id = $1
              AND policy_key = $2
              AND enabled = true
            ORDER BY version DESC
            LIMIT 1`,
          [context.project_id, input.commandPolicyKey],
        );
        commandPolicy = (policyResult.rows[0] as Record<string, unknown> | undefined) ?? null;
        if (!commandPolicy) {
          throw new Error(
            `Workspace command policy not found or disabled: ${input.commandPolicyKey}`,
          );
        }
      } else if (input.commandPolicyKey !== null) {
        throw new Error("commandPolicyKey is only valid for REQUEST_COMMANDS proposals");
      }

      const decisionInput = {
        projectId: context.project_id,
        builderInvocationId: context.builder_invocation_id,
        builderProposalRequestId: context.builder_proposal_request_id,
        builderProposalRunId: context.builder_proposal_run_id,
        builderProposalEvidenceId: context.builder_proposal_evidence_id,
        proposalHash: context.proposal_hash,
        action: context.proposal_action,
        turnNumber: context.turn_number,
        repositoryWorkspaceId: context.repository_workspace_id,
        workspaceStateVersion: context.workspace_state_version,
        taskContextPackId: context.task_context_pack_id,
        taskContextPackHash: context.task_context_pack_hash,
        commandPolicyId: commandPolicy === null ? null : String(commandPolicy.id),
        commandPolicyHash: commandPolicy === null ? null : String(commandPolicy.policy_hash),
      } as const;
      const decisionContent = buildBuilderProposalActionDecisionContent(decisionInput);
      const decisionHash = hashBuilderProposalActionDecision(decisionInput);
      const decisionResult = await client.query(
        `INSERT INTO builder_proposal_action_decisions(
           project_id, builder_invocation_id, builder_proposal_request_id,
           builder_proposal_run_id, builder_proposal_evidence_id,
           repository_workspace_id, workspace_state_version,
           task_context_pack_id, task_context_pack_hash, turn_number,
           action, proposal_hash, command_policy_id, command_policy_hash,
           decision_content, decision_hash, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15::jsonb, $16, $17
         )
         RETURNING *`,
        [
          context.project_id,
          context.builder_invocation_id,
          context.builder_proposal_request_id,
          context.builder_proposal_run_id,
          context.builder_proposal_evidence_id,
          context.repository_workspace_id,
          context.workspace_state_version,
          context.task_context_pack_id,
          context.task_context_pack_hash,
          context.turn_number,
          context.proposal_action,
          context.proposal_hash,
          commandPolicy === null ? null : commandPolicy.id,
          commandPolicy === null ? null : commandPolicy.policy_hash,
          JSON.stringify(decisionContent),
          decisionHash,
          input.actor.id,
        ],
      );
      const decision = decisionResult.rows[0] as Record<string, unknown>;
      const runResult = await client.query(
        `INSERT INTO builder_proposal_action_runs(
           project_id, builder_proposal_action_decision_id, builder_invocation_id
         ) VALUES ($1, $2, $3)
         RETURNING *`,
        [context.project_id, decision.id, context.builder_invocation_id],
      );
      const run = runResult.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action: "BUILDER_PROPOSAL_ACTION_PREPARED",
        entityType: "BUILDER_PROPOSAL_ACTION_RUN",
        entityId: String(run.id),
        data: {
          builderProposalRunId: context.builder_proposal_run_id,
          turnNumber: context.turn_number,
          proposalAction: context.proposal_action,
          decisionHash,
        },
      });
      return {
        decision,
        run,
        evidence: null,
        proposal: proposalFromJson(context.proposal_content),
        commandPolicy,
      };
    });
  }

  private async commandPolicyForDecision(
    client: PoolClient,
    projectId: string,
    commandPolicyId: unknown,
  ): Promise<Record<string, unknown> | null> {
    if (typeof commandPolicyId !== "string") {
      return null;
    }
    const result = await client.query(
      `SELECT * FROM workspace_command_policies WHERE id = $1 AND project_id = $2`,
      [commandPolicyId, projectId],
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  public async markBuilderProposalActionMaterialized(
    input: MarkBuilderProposalActionMaterializedInput,
  ): Promise<Record<string, unknown>> {
    const entities = normalizeBuilderProposalActionEntities(input.materializedEntities);
    return this.transaction(async (client) => {
      const current = await this.hydrateRun(client, input.builderProposalActionRunId, true);
      if (!current) {
        throw new Error(
          `Builder proposal action run not found: ${input.builderProposalActionRunId}`,
        );
      }
      if (current.status === "SATISFIED") {
        return current;
      }
      if (current.status === "MATERIALIZED") {
        if (JSON.stringify(current.materialized_entities) !== JSON.stringify(entitiesJson(entities))) {
          throw new Error(
            "Builder proposal action conflict: action is already materialized with different destination evidence",
          );
        }
        return current;
      }
      const result = await client.query(
        `UPDATE builder_proposal_action_runs
            SET status = 'MATERIALIZED',
                state_version = state_version + 1,
                materialized_entities = $2::jsonb,
                materialized_at = now(),
                updated_at = now()
          WHERE id = $1
            AND status = 'PREPARED'
          RETURNING *`,
        [input.builderProposalActionRunId, JSON.stringify(entitiesJson(entities))],
      );
      if (result.rowCount !== 1) {
        throw new Error("Builder proposal action conflict: action could not be materialized");
      }
      const updated = result.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: String(updated.project_id),
        actor: input.actor,
        action: "BUILDER_PROPOSAL_ACTION_MATERIALIZED",
        entityType: "BUILDER_PROPOSAL_ACTION_RUN",
        entityId: input.builderProposalActionRunId,
        data: { materializedEntityCount: entities.length },
      });
      return (await this.hydrateRun(client, input.builderProposalActionRunId)) ?? updated;
    });
  }

  public async refreshBuilderProposalAction(
    input: RefreshBuilderProposalActionInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const current = await this.hydrateRun(client, input.builderProposalActionRunId, true);
      if (!current) {
        throw new Error(
          `Builder proposal action run not found: ${input.builderProposalActionRunId}`,
        );
      }
      if (current.status !== "MATERIALIZED") {
        return current;
      }
      const decision = recordValue(current.decision, "decision");
      const action = String(decision.action) as BuilderProposalAction;
      const entities = jsonArray(current.materialized_entities, "materialized entities").map(
        (value) => recordValue(value, "materialized entity") as unknown as BuilderProposalActionMaterializedEntity,
      );
      const terminalResult = await this.collectTerminalResults(
        client,
        String(current.project_id),
        action,
        entities,
        String(decision.builder_proposal_evidence_id),
      );
      if (terminalResult === null) {
        return current;
      }

      const outcome = action === "COMPLETE" || action === "BLOCKED"
        ? "TERMINAL"
        : "RESULT_READY";
      const resultInput = {
        action,
        outcome,
        materializedEntities: entities,
        results: terminalResult,
      } as const;
      const resultContent = buildBuilderProposalActionResultContent(resultInput);
      const resultHash = hashBuilderProposalActionResult(resultInput);
      const existingEvidenceResult = await client.query(
        `SELECT *
           FROM builder_proposal_action_evidence
          WHERE builder_proposal_action_run_id = $1`,
        [input.builderProposalActionRunId],
      );
      let evidence = existingEvidenceResult.rows[0] as Record<string, unknown> | undefined;
      if (!evidence) {
        const evidenceResult = await client.query(
          `INSERT INTO builder_proposal_action_evidence(
             project_id, builder_proposal_action_run_id, action, outcome,
             result_content, result_hash, created_by
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           RETURNING *`,
          [
            current.project_id,
            input.builderProposalActionRunId,
            action,
            outcome,
            JSON.stringify(resultContent),
            resultHash,
            input.actor.id,
          ],
        );
        evidence = evidenceResult.rows[0] as Record<string, unknown>;
      } else if (evidence.result_hash !== resultHash) {
        throw new Error(
          "Builder proposal action conflict: immutable result evidence differs from current terminal state",
        );
      }

      await client.query(
        `UPDATE builder_proposal_action_runs
            SET status = 'SATISFIED',
                state_version = state_version + 1,
                satisfied_at = now(),
                updated_at = now()
          WHERE id = $1
            AND status = 'MATERIALIZED'`,
        [input.builderProposalActionRunId],
      );
      await appendAudit(client, {
        projectId: String(current.project_id),
        actor: input.actor,
        action: "BUILDER_PROPOSAL_ACTION_SATISFIED",
        entityType: "BUILDER_PROPOSAL_ACTION_RUN",
        entityId: input.builderProposalActionRunId,
        data: { action, outcome, resultHash },
      });
      return (await this.hydrateRun(client, input.builderProposalActionRunId)) ?? {
        ...current,
        status: "SATISFIED",
        evidence,
      };
    });
  }

  private async collectTerminalResults(
    client: PoolClient,
    projectId: string,
    action: BuilderProposalAction,
    entities: readonly BuilderProposalActionMaterializedEntity[],
    proposalEvidenceId: string,
  ): Promise<JsonValue | null> {
    if (action === "COMPLETE" || action === "BLOCKED") {
      const result = await client.query(
        `SELECT proposal_content
           FROM builder_proposal_evidence
          WHERE id = $1 AND project_id = $2`,
        [proposalEvidenceId, projectId],
      );
      const proposal = recordValue(result.rows[0]?.proposal_content, "proposal content");
      return {
        summary: String(proposal.summary ?? ""),
        blockingReason: proposal.blockingReason === undefined ? null : proposal.blockingReason as JsonValue,
      };
    }

    if (action === "REQUEST_CONTEXT") {
      const entity = entities[0];
      if (!entity) {
        throw new Error("Builder proposal action conflict: missing read-context entity");
      }
      const result = await client.query(
        `SELECT run.status,
                request.id AS request_id,
                snapshot.id AS snapshot_id,
                snapshot.snapshot_hash
           FROM workspace_read_context_runs run
           JOIN workspace_read_context_requests request
             ON request.id = run.workspace_read_context_request_id
            AND request.project_id = run.project_id
           LEFT JOIN workspace_read_context_snapshots snapshot
             ON snapshot.workspace_read_context_run_id = run.id
            AND snapshot.project_id = run.project_id
          WHERE run.id = $1 AND run.project_id = $2`,
        [entity.runId, projectId],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row || row.status === "PREPARED" || row.status === "CAPTURING") {
        return null;
      }
      return {
        status: String(row.status),
        requestId: String(row.request_id),
        runId: entity.runId,
        snapshotId: row.snapshot_id === null ? null : String(row.snapshot_id),
        snapshotHash: row.snapshot_hash === null ? null : String(row.snapshot_hash),
      };
    }

    if (action === "REQUEST_COMMANDS") {
      const results: JsonValue[] = [];
      for (const entity of entities) {
        const result = await client.query(
          `SELECT run.status,
                  evidence.id AS evidence_id,
                  evidence.result_hash
             FROM workspace_command_runs run
             LEFT JOIN workspace_command_evidence evidence
               ON evidence.workspace_command_run_id = run.id
              AND evidence.project_id = run.project_id
            WHERE run.id = $1 AND run.project_id = $2`,
          [entity.runId, projectId],
        );
        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (!row || row.status === "PREPARED" || row.status === "RUNNING") {
          return null;
        }
        if (row.evidence_id === null || row.evidence_id === undefined) {
          throw new Error("Builder proposal action conflict: terminal command lacks immutable evidence");
        }
        results.push({
          ordinal: entity.ordinal,
          status: String(row.status),
          planId: entity.recordId,
          runId: entity.runId,
          evidenceId: String(row.evidence_id),
          resultHash: String(row.result_hash),
        });
      }
      return results;
    }

    const entity = entities[0];
    if (!entity) {
      throw new Error("Builder proposal action conflict: missing mutation entity");
    }
    const result = await client.query(
      `SELECT run.status,
              evidence.id AS evidence_id,
              evidence.result_hash
         FROM workspace_mutation_runs run
         LEFT JOIN workspace_mutation_evidence evidence
           ON evidence.workspace_mutation_run_id = run.id
          AND evidence.project_id = run.project_id
        WHERE run.id = $1 AND run.project_id = $2`,
      [entity.runId, projectId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row || row.status === "PREPARED" || row.status === "APPLYING") {
      return null;
    }
    if (row.evidence_id === null || row.evidence_id === undefined) {
      throw new Error("Builder proposal action conflict: terminal mutation lacks immutable evidence");
    }
    return {
      status: String(row.status),
      planId: entity.recordId,
      runId: entity.runId,
      evidenceId: String(row.evidence_id),
      resultHash: String(row.result_hash),
    };
  }

  public async getBuilderProposalActionRun(
    builderProposalActionRunId: string,
  ): Promise<Record<string, unknown> | null> {
    const client = await this.pool.connect();
    try {
      return await this.hydrateRun(client, builderProposalActionRunId);
    } finally {
      client.release();
    }
  }

  public async getProjectBuilderProposalActionStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `SELECT status, count(*)::integer AS count
         FROM builder_proposal_action_runs
        WHERE project_id = $1
        GROUP BY status
        ORDER BY status`,
      [projectId],
    );
    return { projectId, states: result.rows };
  }

  public async getPlatformBuilderProposalActionStatus(): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `SELECT status, count(*)::integer AS count
         FROM builder_proposal_action_runs
        GROUP BY status
        ORDER BY status`,
    );
    return { states: result.rows };
  }
}
