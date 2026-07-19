import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  buildBuilderProposalRequestContent,
  hashBuilderProposalRequest,
} from "../domain/builder-proposal.js";
import type { JsonValue } from "../domain/stable-json.js";
import { PostgresBuilderProposalStore } from "./builder-proposal-store.js";
import type { PrepareBuilderProposalInput } from "./builder-proposal-types.js";
import type { Actor } from "./types.js";

interface OrchestratedProposalContextRow extends QueryResultRow {
  readonly builder_invocation_id: string;
  readonly project_id: string;
  readonly invocation_status: string;
  readonly builder_invocation_plan_id: string;
  readonly builder_plan_hash: string;
  readonly execution_attempt_id: string;
  readonly task_context_pack_id: string;
  readonly task_context_pack_hash: string;
  readonly provider_dispatch_decision_id: string;
  readonly provider_key: string;
  readonly task_context_pack_content: JsonValue;
  readonly workspace_read_context_snapshot_id: string;
  readonly workspace_read_context_snapshot_hash: string;
  readonly source_snapshot_content: JsonValue;
  readonly relevant_paths: JsonValue;
  readonly previous_action_evidence_id: string | null;
  readonly previous_action_evidence_hash: string | null;
}

function stringArray(value: JsonValue, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Builder proposal conflict: ${field} must be a string array`);
  }
  return value as string[];
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

export class OrchestratedPostgresBuilderProposalStore extends PostgresBuilderProposalStore {
  public constructor(private readonly orchestrationPool: Pool) {
    super(orchestrationPool);
  }

  public override async prepareBuilderProposal(
    input: PrepareBuilderProposalInput,
  ): Promise<Record<string, unknown>> {
    const client = await this.orchestrationPool.connect();
    try {
      await client.query("BEGIN");
      const contextResult = await client.query<OrchestratedProposalContextRow>(
        `SELECT invocation.id AS builder_invocation_id,
                invocation.project_id,
                invocation.status AS invocation_status,
                plan.id AS builder_invocation_plan_id,
                plan.plan_hash AS builder_plan_hash,
                plan.execution_attempt_id,
                plan.task_context_pack_id,
                plan.task_context_pack_hash,
                plan.provider_dispatch_decision_id,
                plan.provider_key,
                context_pack.content AS task_context_pack_content,
                snapshot.id AS workspace_read_context_snapshot_id,
                snapshot.snapshot_hash AS workspace_read_context_snapshot_hash,
                snapshot.snapshot_content AS source_snapshot_content,
                capture_request.relevant_paths,
                previous_action.evidence_id AS previous_action_evidence_id,
                previous_action.evidence_hash AS previous_action_evidence_hash
           FROM builder_invocations invocation
           JOIN builder_invocation_plans plan
             ON plan.id = invocation.builder_invocation_plan_id
            AND plan.project_id = invocation.project_id
           JOIN task_context_packs context_pack
             ON context_pack.id = plan.task_context_pack_id
            AND context_pack.project_id = invocation.project_id
           JOIN workspace_read_context_runs capture_run
             ON capture_run.id = $2
            AND capture_run.project_id = invocation.project_id
            AND capture_run.status = 'CAPTURED'
           JOIN workspace_read_context_requests capture_request
             ON capture_request.id = capture_run.workspace_read_context_request_id
            AND capture_request.project_id = capture_run.project_id
            AND capture_request.builder_invocation_id = invocation.id
            AND capture_request.task_context_pack_id = plan.task_context_pack_id
            AND capture_request.task_context_pack_hash = plan.task_context_pack_hash
           JOIN workspace_read_context_snapshots snapshot
             ON snapshot.workspace_read_context_run_id = capture_run.id
            AND snapshot.project_id = capture_run.project_id
           LEFT JOIN LATERAL (
             SELECT action_evidence.id AS evidence_id,
                    action_evidence.result_hash AS evidence_hash
               FROM builder_proposal_action_decisions decision
               JOIN builder_proposal_action_runs action_run
                 ON action_run.builder_proposal_action_decision_id = decision.id
                AND action_run.project_id = decision.project_id
               JOIN builder_proposal_action_evidence action_evidence
                 ON action_evidence.builder_proposal_action_run_id = action_run.id
                AND action_evidence.project_id = action_run.project_id
              WHERE decision.project_id = invocation.project_id
                AND decision.builder_invocation_id = invocation.id
                AND action_run.status = 'SATISFIED'
              ORDER BY decision.turn_number DESC
              LIMIT 1
           ) previous_action ON true
          WHERE invocation.id = $1
          FOR UPDATE OF invocation`,
        [input.builderInvocationId, input.workspaceReadContextRunId],
      );
      const context = contextResult.rows[0];
      if (!context) {
        throw new Error(
          "Builder proposal context not found or source snapshot does not match builder invocation",
        );
      }
      if (context.invocation_status !== "PREPARED") {
        throw new Error(
          `Builder proposal conflict: builder invocation status ${context.invocation_status} is not PREPARED`,
        );
      }

      const relevantPaths = stringArray(context.relevant_paths, "relevant paths");
      const requestInput = {
        projectId: context.project_id,
        builderInvocationId: context.builder_invocation_id,
        builderInvocationPlanId: context.builder_invocation_plan_id,
        builderPlanHash: context.builder_plan_hash,
        executionAttemptId: context.execution_attempt_id,
        taskContextPackId: context.task_context_pack_id,
        taskContextPackHash: context.task_context_pack_hash,
        providerDispatchDecisionId: context.provider_dispatch_decision_id,
        providerKey: context.provider_key,
        workspaceReadContextSnapshotId: context.workspace_read_context_snapshot_id,
        workspaceReadContextSnapshotHash: context.workspace_read_context_snapshot_hash,
        relevantPaths,
        taskContextPackContent: context.task_context_pack_content,
        sourceSnapshotContent: context.source_snapshot_content,
        previousActionEvidenceId: context.previous_action_evidence_id,
        previousActionEvidenceHash: context.previous_action_evidence_hash,
      } as const;
      const inputContent = buildBuilderProposalRequestContent(requestInput);
      const inputHash = hashBuilderProposalRequest(requestInput);

      const existingResult = await client.query(
        `SELECT request.*,
                row_to_json(run) AS run,
                row_to_json(evidence) AS evidence
           FROM builder_proposal_requests request
           JOIN builder_proposal_runs run
             ON run.builder_proposal_request_id = request.id
            AND run.project_id = request.project_id
           LEFT JOIN builder_proposal_evidence evidence
             ON evidence.builder_proposal_run_id = run.id
            AND evidence.project_id = run.project_id
          WHERE request.project_id = $1
            AND request.input_hash = $2`,
        [context.project_id, inputHash],
      );
      const existing = existingResult.rows[0] as Record<string, unknown> | undefined;
      if (existing) {
        await client.query("COMMIT");
        return {
          request: existing,
          run: existing.run as Record<string, unknown>,
          evidence: (existing.evidence as Record<string, unknown> | null) ?? null,
        };
      }

      const requestResult = await client.query(
        `INSERT INTO builder_proposal_requests(
           project_id, builder_invocation_id, builder_invocation_plan_id,
           execution_attempt_id, task_context_pack_id, task_context_pack_hash,
           provider_dispatch_decision_id, provider_key,
           workspace_read_context_snapshot_id, workspace_read_context_snapshot_hash,
           previous_action_evidence_id, previous_action_evidence_hash,
           relevant_paths, adapter_key, input_content, input_hash, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13::jsonb, 'fixture-proposal', $14::jsonb, $15, $16
         )
         RETURNING *`,
        [
          context.project_id,
          context.builder_invocation_id,
          context.builder_invocation_plan_id,
          context.execution_attempt_id,
          context.task_context_pack_id,
          context.task_context_pack_hash,
          context.provider_dispatch_decision_id,
          context.provider_key,
          context.workspace_read_context_snapshot_id,
          context.workspace_read_context_snapshot_hash,
          context.previous_action_evidence_id,
          context.previous_action_evidence_hash,
          JSON.stringify(relevantPaths),
          JSON.stringify(inputContent),
          inputHash,
          input.actor.id,
        ],
      );
      const request = requestResult.rows[0] as Record<string, unknown>;
      const runResult = await client.query(
        `INSERT INTO builder_proposal_runs(
           project_id, builder_proposal_request_id, builder_invocation_id
         ) VALUES ($1, $2, $3)
         RETURNING *`,
        [context.project_id, request.id, context.builder_invocation_id],
      );
      const run = runResult.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action: "BUILDER_PROPOSAL_PREPARED",
        entityType: "BUILDER_PROPOSAL_RUN",
        entityId: String(run.id),
        data: {
          builderInvocationId: context.builder_invocation_id,
          inputHash,
          snapshotHash: context.workspace_read_context_snapshot_hash,
          previousActionEvidenceHash: context.previous_action_evidence_hash,
          adapterKey: "fixture-proposal",
        },
      });
      await client.query("COMMIT");
      return { request, run, evidence: null };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
