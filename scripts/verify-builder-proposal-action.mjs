import assert from "node:assert/strict";

import pg from "pg";

import { BuilderProposalActionService } from "../dist/services/builder-proposal-action-service.js";
import { PostgresBuilderProposalActionStore } from "../dist/store/builder-proposal-action-store.js";
import { OrchestratedPostgresBuilderProposalStore } from "../dist/store/orchestrated-builder-proposal-store.js";
import { PostgresWorkspaceCommandStore } from "../dist/store/workspace-command-store.js";
import { PostgresWorkspaceMutationStore } from "../dist/store/workspace-mutation-store.js";
import { PostgresWorkspaceReadContextStore } from "../dist/store/workspace-read-context-store.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

async function expectRejected(operation, message) {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true, message);
}

const pool = new Pool({ connectionString: databaseUrl });
const proposalStore = new OrchestratedPostgresBuilderProposalStore(pool);
const actionStore = new PostgresBuilderProposalActionStore(pool);
const actionService = new BuilderProposalActionService(
  actionStore,
  new PostgresWorkspaceCommandStore(pool),
  new PostgresWorkspaceMutationStore(pool),
  new PostgresWorkspaceReadContextStore(pool),
);
const actor = { type: "SYSTEM", id: "ci-builder-proposal-action-verifier" };

try {
  const fixtureResult = await pool.query(
    `SELECT proposal_run.id AS proposal_run_id,
            request.builder_invocation_id,
            capture_run.id AS read_context_run_id
       FROM builder_proposal_evidence proposal_evidence
       JOIN builder_proposal_runs proposal_run
         ON proposal_run.id = proposal_evidence.builder_proposal_run_id
        AND proposal_run.project_id = proposal_evidence.project_id
       JOIN builder_proposal_requests request
         ON request.id = proposal_run.builder_proposal_request_id
        AND request.project_id = proposal_run.project_id
       JOIN workspace_read_context_snapshots snapshot
         ON snapshot.id = request.workspace_read_context_snapshot_id
        AND snapshot.project_id = request.project_id
       JOIN workspace_read_context_runs capture_run
         ON capture_run.id = snapshot.workspace_read_context_run_id
        AND capture_run.project_id = snapshot.project_id
       JOIN projects project
         ON project.id = request.project_id
      WHERE project.slug LIKE 'ci-proposal-%'
        AND proposal_evidence.outcome = 'GENERATED'
        AND proposal_evidence.proposal_action = 'COMPLETE'
      ORDER BY proposal_evidence.created_at DESC
      LIMIT 1`,
  );
  const fixture = fixtureResult.rows[0];
  assert.ok(fixture, "ADP-017 verifier must leave one generated fixture proposal");

  const [firstActionA, firstActionB] = await Promise.all([
    actionService.authorizeAndMaterialize({
      builderProposalRunId: fixture.proposal_run_id,
      commandPolicyKey: null,
      actor,
    }),
    actionService.authorizeAndMaterialize({
      builderProposalRunId: fixture.proposal_run_id,
      commandPolicyKey: null,
      actor,
    }),
  ]);
  assert.equal(String(firstActionA.id), String(firstActionB.id));
  assert.equal(firstActionA.status, "SATISFIED");
  assert.equal(firstActionA.evidence.outcome, "TERMINAL");
  assert.match(String(firstActionA.evidence.result_hash), /^[a-f0-9]{64}$/);

  const firstDecisionCount = await pool.query(
    `SELECT count(*)::int AS count
       FROM builder_proposal_action_decisions
      WHERE builder_proposal_run_id = $1`,
    [fixture.proposal_run_id],
  );
  assert.equal(firstDecisionCount.rows[0].count, 1);

  const secondProposal = await proposalStore.prepareBuilderProposal({
    builderInvocationId: fixture.builder_invocation_id,
    workspaceReadContextRunId: fixture.read_context_run_id,
    actor,
  });
  assert.notEqual(String(secondProposal.run.id), String(fixture.proposal_run_id));
  assert.equal(secondProposal.run.status, "PREPARED");
  assert.equal(
    String(secondProposal.request.previous_action_evidence_id),
    String(firstActionA.evidence.id),
  );
  assert.equal(
    String(secondProposal.request.previous_action_evidence_hash),
    String(firstActionA.evidence.result_hash),
  );
  const previousActionContent = secondProposal.request.input_content.previousActionEvidence;
  assert.equal(previousActionContent.id, String(firstActionA.evidence.id));
  assert.equal(previousActionContent.resultHash, String(firstActionA.evidence.result_hash));

  await expectRejected(
    () =>
      pool.query(
        `INSERT INTO builder_proposal_requests(
           project_id, builder_invocation_id, builder_invocation_plan_id,
           execution_attempt_id, task_context_pack_id, task_context_pack_hash,
           provider_dispatch_decision_id, provider_key,
           workspace_read_context_snapshot_id, workspace_read_context_snapshot_hash,
           previous_action_evidence_id, previous_action_evidence_hash,
           relevant_paths, adapter_key, input_content, input_hash, created_by
         )
         SELECT project_id, builder_invocation_id, builder_invocation_plan_id,
                execution_attempt_id, task_context_pack_id, task_context_pack_hash,
                provider_dispatch_decision_id, provider_key,
                workspace_read_context_snapshot_id, workspace_read_context_snapshot_hash,
                previous_action_evidence_id, previous_action_evidence_hash,
                relevant_paths, adapter_key, input_content, repeat('f', 64),
                'ci-builder-proposal-action-verifier'
           FROM builder_proposal_requests
          WHERE id = $1`,
        [secondProposal.request.id],
      ),
    "a third proposal request must be rejected when immutable maxTurns is exhausted",
  );

  await expectRejected(
    () =>
      pool.query(
        "UPDATE builder_proposal_action_decisions SET action = 'BLOCKED' WHERE id = $1",
        [firstActionA.decision.id],
      ),
    "proposal action decisions must be immutable",
  );
  await expectRejected(
    () =>
      pool.query(
        "DELETE FROM builder_proposal_action_evidence WHERE id = $1",
        [firstActionA.evidence.id],
      ),
    "proposal action evidence must be immutable",
  );

  const activeActions = await pool.query(
    `SELECT count(*)::int AS count
       FROM builder_proposal_action_runs
      WHERE builder_invocation_id = $1
        AND status IN ('PREPARED', 'MATERIALIZED')`,
    [fixture.builder_invocation_id],
  );
  assert.equal(activeActions.rows[0].count, 0);

  const globalCapabilities = await pool.query(
    `SELECT capability, enabled
       FROM capability_switches
      WHERE scope_type = 'GLOBAL'
        AND capability IN ('AI_DISPATCH', 'AUTOMATED_WRITE')
      ORDER BY capability`,
  );
  assert.equal(globalCapabilities.rows.length, 2);
  assert.equal(globalCapabilities.rows.every((row) => row.enabled === false), true);

  console.log("Builder proposal action orchestration invariants verified successfully.");
} finally {
  await pool.end();
}
