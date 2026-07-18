import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  buildBuilderProposalRequestContent,
  builderProposalContent,
  hashBuilderProposal,
  hashBuilderProposalRequest,
  normalizeBuilderProposal,
} from "../domain/builder-proposal.js";
import { sha256Json, type JsonValue } from "../domain/stable-json.js";
import type {
  BuilderProposalStore,
  ClaimBuilderProposalRunInput,
  ClaimBuilderProposalRunResult,
  CompleteBuilderProposalRunInput,
  FailBuilderProposalRunInput,
  PrepareBuilderProposalInput,
} from "./builder-proposal-types.js";
import type { Actor } from "./types.js";

interface ProposalContextRow extends QueryResultRow {
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
    throw new Error(`Builder proposal conflict: ${field} must be a string array`);
  }
  return value as string[];
}

export class PostgresBuilderProposalStore implements BuilderProposalStore {
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

  public async prepareBuilderProposal(
    input: PrepareBuilderProposalInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const contextResult = await client.query<ProposalContextRow>(
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
                capture_request.relevant_paths
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
           relevant_paths, adapter_key, input_content, input_hash, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11::jsonb, 'fixture-proposal', $12::jsonb, $13, $14
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
          adapterKey: "fixture-proposal",
        },
      });
      return { request, run, evidence: null };
    });
  }

  public async claimBuilderProposalRun(
    input: ClaimBuilderProposalRunInput,
  ): Promise<ClaimBuilderProposalRunResult> {
    try {
      return await this.transaction(async (client) => {
        const claimResult = await client.query(
          `UPDATE builder_proposal_runs
              SET status = 'GENERATING',
                  state_version = state_version + 1,
                  builder_dispatch_claim_id = $2,
                  builder_dispatch_revalidation_id = $3,
                  started_at = now(),
                  updated_at = now()
            WHERE id = $1
              AND status = 'PREPARED'
            RETURNING *`,
          [
            input.builderProposalRunId,
            input.builderDispatchClaimId,
            input.builderDispatchRevalidationId,
          ],
        );
        const currentResult = await client.query(
          `SELECT run.*,
                  row_to_json(request) AS request,
                  row_to_json(evidence) AS evidence
             FROM builder_proposal_runs run
             JOIN builder_proposal_requests request
               ON request.id = run.builder_proposal_request_id
              AND request.project_id = run.project_id
             LEFT JOIN builder_proposal_evidence evidence
               ON evidence.builder_proposal_run_id = run.id
              AND evidence.project_id = run.project_id
            WHERE run.id = $1`,
          [input.builderProposalRunId],
        );
        const current = currentResult.rows[0] as Record<string, unknown> | undefined;
        if (!current) {
          throw new Error(`Builder proposal run not found: ${input.builderProposalRunId}`);
        }
        const request = current.request as Record<string, unknown>;
        const claimed = claimResult.rowCount === 1;
        if (claimed) {
          await appendAudit(client, {
            projectId: String(current.project_id),
            actor: input.actor,
            action: "BUILDER_PROPOSAL_CLAIMED",
            entityType: "BUILDER_PROPOSAL_RUN",
            entityId: input.builderProposalRunId,
            data: {
              inputHash: String(request.input_hash),
              builderDispatchClaimId: input.builderDispatchClaimId,
              builderDispatchRevalidationId: input.builderDispatchRevalidationId,
            },
          });
        }
        return { claimed, run: current, request };
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const current = await this.getBuilderProposalRun(input.builderProposalRunId);
        if (!current) {
          throw new Error(`Builder proposal run not found: ${input.builderProposalRunId}`);
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

  public async completeBuilderProposalRun(
    input: CompleteBuilderProposalRunInput,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const currentResult = await client.query(
        `SELECT run.*,
                row_to_json(request) AS request,
                row_to_json(evidence) AS evidence
           FROM builder_proposal_runs run
           JOIN builder_proposal_requests request
             ON request.id = run.builder_proposal_request_id
            AND request.project_id = run.project_id
           LEFT JOIN builder_proposal_evidence evidence
             ON evidence.builder_proposal_run_id = run.id
            AND evidence.project_id = run.project_id
          WHERE run.id = $1
          FOR UPDATE OF run`,
        [input.builderProposalRunId],
      );
      const current = currentResult.rows[0] as Record<string, unknown> | undefined;
      if (!current) {
        throw new Error(`Builder proposal run not found: ${input.builderProposalRunId}`);
      }
      if (current.status === "GENERATED") {
        return current;
      }
      if (current.status !== "GENERATING") {
        throw new Error(
          `Builder proposal conflict: run status ${String(current.status)} cannot complete`,
        );
      }
      const request = current.request as Record<string, unknown>;
      const relevantPaths = stringArray(request.relevant_paths as JsonValue, "relevant paths");
      const proposal = normalizeBuilderProposal(input.proposal, relevantPaths);
      const proposalContent = builderProposalContent(proposal, relevantPaths);
      const proposalHash = hashBuilderProposal(proposal, relevantPaths);
      const resultContent: JsonValue = {
        builderProposalRunId: input.builderProposalRunId,
        inputHash: String(request.input_hash),
        proposalHash,
        proposalAction: proposal.action,
        externalProviderCalled: input.externalProviderCalled,
        providerRequestId: input.providerRequestId,
        usage: input.usage,
      };
      const resultHash = sha256Json(resultContent);

      const evidenceResult = await client.query(
        `INSERT INTO builder_proposal_evidence(
           project_id, builder_proposal_run_id, outcome, proposal_action,
           proposal_content, proposal_hash, external_provider_called,
           provider_request_id, usage, error_code, result_hash, created_by
         ) VALUES (
           $1, $2, 'GENERATED', $3, $4::jsonb, $5, $6, $7,
           $8::jsonb, NULL, $9, $10
         )
         RETURNING *`,
        [
          current.project_id,
          input.builderProposalRunId,
          proposal.action,
          JSON.stringify(proposalContent),
          proposalHash,
          input.externalProviderCalled,
          input.providerRequestId,
          JSON.stringify(input.usage),
          resultHash,
          input.actor.id,
        ],
      );
      const evidence = evidenceResult.rows[0] as Record<string, unknown>;
      const runResult = await client.query(
        `UPDATE builder_proposal_runs
            SET status = 'GENERATED',
                state_version = state_version + 1,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [input.builderProposalRunId],
      );
      const run = runResult.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: String(current.project_id),
        actor: input.actor,
        action: "BUILDER_PROPOSAL_GENERATED",
        entityType: "BUILDER_PROPOSAL_RUN",
        entityId: input.builderProposalRunId,
        data: { proposalAction: proposal.action, proposalHash, resultHash },
      });
      return { run, request, evidence };
    });
  }

  public async failBuilderProposalRun(
    input: FailBuilderProposalRunInput,
  ): Promise<Record<string, unknown>> {
    if (!/^[A-Z0-9_]{1,64}$/.test(input.errorCode)) {
      throw new Error("Builder proposal errorCode must be a stable uppercase code");
    }
    return this.transaction(async (client) => {
      const currentResult = await client.query(
        `SELECT run.*,
                row_to_json(request) AS request,
                row_to_json(evidence) AS evidence
           FROM builder_proposal_runs run
           JOIN builder_proposal_requests request
             ON request.id = run.builder_proposal_request_id
            AND request.project_id = run.project_id
           LEFT JOIN builder_proposal_evidence evidence
             ON evidence.builder_proposal_run_id = run.id
            AND evidence.project_id = run.project_id
          WHERE run.id = $1
          FOR UPDATE OF run`,
        [input.builderProposalRunId],
      );
      const current = currentResult.rows[0] as Record<string, unknown> | undefined;
      if (!current) {
        throw new Error(`Builder proposal run not found: ${input.builderProposalRunId}`);
      }
      if (current.status === "FAILED") {
        return current;
      }
      if (current.status !== "GENERATING") {
        throw new Error(
          `Builder proposal conflict: run status ${String(current.status)} cannot fail`,
        );
      }
      const request = current.request as Record<string, unknown>;
      const resultContent: JsonValue = {
        builderProposalRunId: input.builderProposalRunId,
        inputHash: String(request.input_hash),
        outcome: "FAILED",
        errorCode: input.errorCode,
        usage: input.usage,
      };
      const resultHash = sha256Json(resultContent);
      const evidenceResult = await client.query(
        `INSERT INTO builder_proposal_evidence(
           project_id, builder_proposal_run_id, outcome, proposal_action,
           proposal_content, proposal_hash, external_provider_called,
           provider_request_id, usage, error_code, result_hash, created_by
         ) VALUES (
           $1, $2, 'FAILED', NULL, NULL, NULL, false, NULL,
           $3::jsonb, $4, $5, $6
         )
         RETURNING *`,
        [
          current.project_id,
          input.builderProposalRunId,
          JSON.stringify(input.usage),
          input.errorCode,
          resultHash,
          input.actor.id,
        ],
      );
      const evidence = evidenceResult.rows[0] as Record<string, unknown>;
      const runResult = await client.query(
        `UPDATE builder_proposal_runs
            SET status = 'FAILED',
                state_version = state_version + 1,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [input.builderProposalRunId],
      );
      const run = runResult.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: String(current.project_id),
        actor: input.actor,
        action: "BUILDER_PROPOSAL_FAILED",
        entityType: "BUILDER_PROPOSAL_RUN",
        entityId: input.builderProposalRunId,
        data: { errorCode: input.errorCode, resultHash },
      });
      return { run, request, evidence };
    });
  }

  public async getBuilderProposalRun(
    builderProposalRunId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT run.*,
              row_to_json(request) AS request,
              row_to_json(evidence) AS evidence
         FROM builder_proposal_runs run
         JOIN builder_proposal_requests request
           ON request.id = run.builder_proposal_request_id
          AND request.project_id = run.project_id
         LEFT JOIN builder_proposal_evidence evidence
           ON evidence.builder_proposal_run_id = run.id
          AND evidence.project_id = run.project_id
        WHERE run.id = $1`,
      [builderProposalRunId],
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  public async getProjectBuilderProposalStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [counts, recent] = await Promise.all([
      this.pool.query(
        `SELECT status, count(*)::int AS count
           FROM builder_proposal_runs
          WHERE project_id = $1
          GROUP BY status
          ORDER BY status`,
        [projectId],
      ),
      this.pool.query(
        `SELECT run.id, run.status, run.started_at, run.completed_at,
                request.builder_invocation_id, request.provider_key,
                request.input_hash, evidence.proposal_action, evidence.proposal_hash
           FROM builder_proposal_runs run
           JOIN builder_proposal_requests request
             ON request.id = run.builder_proposal_request_id
            AND request.project_id = run.project_id
           LEFT JOIN builder_proposal_evidence evidence
             ON evidence.builder_proposal_run_id = run.id
            AND evidence.project_id = run.project_id
          WHERE run.project_id = $1
          ORDER BY run.created_at DESC
          LIMIT 20`,
        [projectId],
      ),
    ]);
    return { builderProposalCounts: counts.rows, recentBuilderProposals: recent.rows };
  }

  public async getPlatformBuilderProposalStatus(): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `SELECT status, count(*)::int AS count
         FROM builder_proposal_runs
        GROUP BY status
        ORDER BY status`,
    );
    return { builderProposalCounts: result.rows };
  }
}
