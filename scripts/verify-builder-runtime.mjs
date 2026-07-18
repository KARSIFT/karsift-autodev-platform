import assert from "node:assert/strict";

import pg from "pg";

import { BuilderAdapterRegistry } from "../dist/agents/builder-adapter.js";
import { DryRunBuilderAdapter } from "../dist/agents/dry-run-builder-adapter.js";
import { BuilderRuntimeService } from "../dist/services/builder-runtime-service.js";
import { ExtendedPostgresControlPlaneStore } from "../dist/store/extended-postgres-store.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString: databaseUrl });
const store = new ExtendedPostgresControlPlaneStore(pool);
const service = new BuilderRuntimeService(
  store,
  new BuilderAdapterRegistry([new DryRunBuilderAdapter()]),
);
const actor = { type: "SYSTEM", id: "ci-builder-runtime-verifier" };
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

async function expectRejected(operation, message) {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true, message);
}

try {
  const project = await store.createProject(
    {
      slug: `ci-builder-${suffix}`.slice(0, 63),
      name: "CI Builder Runtime Project",
      repositoryFullName: `KARSIFT/ci-builder-${suffix}`,
      defaultBranch: "main",
      integrationBranch: "develop",
    },
    actor,
  );
  const projectId = String(project.id);

  const contractBundle = await store.createChangeContract({
    projectId,
    stableId: `CI-BUILDER-${suffix}`,
    content: {
      objective: "verify controlled builder runtime",
      deliverables: ["bounded immutable builder invocation"],
      acceptanceCriteria: [
        "dry-run adapter produces immutable zero-side-effect evidence",
      ],
      tests: ["builder runtime lifecycle verifier passes"],
      expectedEvidence: ["builder invocation plan and result hashes"],
      governance: {
        riskLevel: "R2",
        founderApprovalRequired: false,
        ehrRequired: false,
        strengthenedGatesSatisfied: false,
        protectedTechnicalWork: false,
      },
    },
    actor,
  });
  const contractId = String(contractBundle.contract.id);
  const versionId = String(contractBundle.version.id);

  const authorization = await store.recordChangeContractAuthorization({
    changeContractId: contractId,
    action: "AUTHORIZE",
    rationale: "CI builder runtime authorization",
    actor,
  });
  assert.equal(authorization.authorized, true);

  const task = await store.createTask({
    projectId,
    changeContractVersionId: versionId,
    title: "Builder runtime verification",
    description: "Exercise the dry-run builder lifecycle",
    priority: "P1",
    actor,
  });
  const work = await store.createWorkQueueItem({
    projectId,
    taskId: String(task.id),
    priority: "P1",
    executionPolicy: "IMMEDIATE",
    scheduledFor: null,
    idempotencyKey: `builder:${projectId}:${task.id}`,
    actor,
  });
  const workQueueItemId = String(work.id);

  const validation = await store.validateWorkQueueItem({
    workQueueItemId,
    actor,
  });
  assert.equal(validation.validation.outcome, "VALID");

  await store.upsertAiBudgetPolicy({
    projectId,
    monthlyLimitMicrousd: 1_000_000,
    perWorkLimitMicrousd: 500_000,
    maxAiTier: 3,
    enabled: true,
    actor,
  });
  const budget = await store.authorizeWorkBudget({
    workQueueItemId,
    executionClass: "AI_TIER_2",
    estimatedMaxCostMicrousd: 100_000,
    actor,
  });
  assert.equal(budget.decision.decision, "APPROVED");
  assert.equal(budget.reservation.status, "RESERVED");

  await store.upsertProviderRoutingPolicy({
    projectId,
    executionClass: "AI_TIER_2",
    capability: "CODE_BUILDER",
    providerKeys: ["ci-dry-run-builder"],
    enabled: true,
    actor,
  });
  const capacity = await store.recordProviderCapacityObservation({
    projectId,
    providerKey: "ci-dry-run-builder",
    capability: "CODE_BUILDER",
    status: "HEALTHY",
    ttlSeconds: 300,
    quotaResetAt: null,
    details: { source: "ci-builder-runtime-verifier" },
    actor,
  });
  const dispatch = await store.evaluateProviderDispatch({
    workQueueItemId,
    capability: "CODE_BUILDER",
    actor,
  });
  assert.equal(dispatch.outcome, "READY");
  assert.equal(dispatch.provider_key, "ci-dry-run-builder");
  assert.equal(String(dispatch.capacity_observation_id), String(capacity.id));

  await pool.query(
    `INSERT INTO capability_switches(
       scope_type, project_id, capability, enabled, reason, updated_by
     ) VALUES (
       'PROJECT', $1, 'AI_DISPATCH', true,
       'CI-only controlled builder runtime verification', 'ci'
     )`,
    [projectId],
  );

  const claim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "ci-builder-runtime-worker",
    leaseSeconds: 300,
    actor,
  });
  assert.notEqual(claim, null);
  assert.equal(String(claim.executionAttempt.provider_dispatch_decision_id), String(dispatch.id));

  const pack = await store.createTaskContextPack({
    executionAttemptId: String(claim.executionAttempt.id),
    leaseToken: String(claim.executionAttempt.lease_token),
    baseBranch: "develop",
    baseCommitSha: "b".repeat(40),
    relevantPaths: ["src/agents", "src/services", "src/store"],
    actor,
  });
  assert.equal(pack.content.schemaVersion, "task-context-pack-v2");

  await expectRejected(
    () =>
      pool.query(
        `INSERT INTO builder_invocation_plans(
           project_id,
           execution_attempt_id,
           task_context_pack_id,
           task_context_pack_hash,
           provider_dispatch_decision_id,
           provider_key,
           adapter_key,
           side_effect_mode,
           max_turns,
           retry_budget,
           command_budget,
           timeout_seconds,
           plan_content,
           plan_hash,
           created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'dry-run', 'NONE',
           1, 0, 0, 30, '{}'::jsonb, $7, 'ci'
         )`,
        [
          projectId,
          claim.executionAttempt.id,
          pack.id,
          "0".repeat(64),
          dispatch.id,
          "ci-dry-run-builder",
          "1".repeat(64),
        ],
      ),
    "database must reject a builder plan with a mismatched Task Context Pack hash",
  );

  const limits = {
    maxTurns: 2,
    retryBudget: 1,
    commandBudget: 10,
    timeoutSeconds: 60,
  };
  const prepared = await store.prepareBuilderInvocation({
    executionAttemptId: String(claim.executionAttempt.id),
    leaseToken: String(claim.executionAttempt.lease_token),
    limits,
    actor,
  });
  assert.equal(prepared.plan.adapter_key, "dry-run");
  assert.equal(prepared.plan.side_effect_mode, "NONE");
  assert.equal(String(prepared.plan.task_context_pack_hash), String(pack.content_hash));
  assert.equal(String(prepared.plan.provider_dispatch_decision_id), String(dispatch.id));
  assert.equal(prepared.plan.provider_key, "ci-dry-run-builder");
  assert.match(String(prepared.plan.plan_hash), /^[a-f0-9]{64}$/);
  assert.equal(prepared.invocation.status, "PREPARED");

  const preparedAgain = await store.prepareBuilderInvocation({
    executionAttemptId: String(claim.executionAttempt.id),
    leaseToken: String(claim.executionAttempt.lease_token),
    limits,
    actor,
  });
  assert.equal(String(preparedAgain.plan.id), String(prepared.plan.id));
  assert.equal(String(preparedAgain.invocation.id), String(prepared.invocation.id));

  await expectRejected(
    () =>
      store.prepareBuilderInvocation({
        executionAttemptId: String(claim.executionAttempt.id),
        leaseToken: String(claim.executionAttempt.lease_token),
        limits: { ...limits, maxTurns: 3 },
        actor,
      }),
    "an execution attempt must not accept a second immutable plan with different limits",
  );

  await expectRejected(
    () =>
      pool.query(
        "UPDATE builder_invocation_plans SET max_turns = 3 WHERE id = $1",
        [prepared.plan.id],
      ),
    "builder invocation plans must be immutable",
  );

  await pool.query(
    `UPDATE capability_switches
        SET enabled = false,
            reason = 'CI prove start-time capability recheck',
            updated_by = 'ci'
      WHERE scope_type = 'PROJECT'
        AND project_id = $1
        AND capability = 'AI_DISPATCH'`,
    [projectId],
  );

  await expectRejected(
    () =>
      service.runBuilderInvocation({
        builderInvocationId: String(prepared.invocation.id),
        actor,
      }),
    "builder invocation start must re-check AI_DISPATCH capability",
  );

  await pool.query(
    `UPDATE capability_switches
        SET enabled = true,
            reason = 'CI continue dry-run lifecycle verification',
            updated_by = 'ci'
      WHERE scope_type = 'PROJECT'
        AND project_id = $1
        AND capability = 'AI_DISPATCH'`,
    [projectId],
  );

  const completed = await service.runBuilderInvocation({
    builderInvocationId: String(prepared.invocation.id),
    actor,
  });
  assert.equal(completed.invocation.status, "SUCCEEDED");
  assert.equal(completed.result.outcome, "SUCCEEDED");
  assert.equal(Number(completed.result.turns_used), 0);
  assert.equal(Number(completed.result.commands_used), 0);
  assert.equal(completed.result.evidence.dryRun, true);
  assert.equal(completed.result.evidence.externalProviderCalled, false);
  assert.equal(completed.result.evidence.repositoryMutated, false);
  assert.match(String(completed.result.evidence_hash), /^[a-f0-9]{64}$/);

  const repeatedCompletion = await store.completeBuilderInvocation({
    builderInvocationId: String(prepared.invocation.id),
    result: {
      outcome: "SUCCEEDED",
      turnsUsed: 0,
      commandsUsed: 0,
      durationMs: 0,
      summary: "Dry-run builder contract validated without external calls or side effects.",
      evidence: {
        dryRun: true,
        externalProviderCalled: false,
        repositoryMutated: false,
        invocationId: String(prepared.invocation.id),
        planHash: String(prepared.plan.plan_hash),
        taskContextPackHash: String(prepared.plan.task_context_pack_hash),
        providerKey: String(prepared.plan.provider_key),
        limits,
      },
    },
    actor,
  });
  assert.equal(String(repeatedCompletion.result.id), String(completed.result.id));

  await expectRejected(
    () =>
      pool.query(
        "UPDATE builder_invocation_results SET summary = 'mutated' WHERE id = $1",
        [completed.result.id],
      ),
    "builder invocation result evidence must be immutable",
  );

  const runtimeStatus = await store.getProjectBuilderRuntimeStatus(projectId);
  assert.equal(runtimeStatus.builderInvocationCounts.length > 0, true);
  assert.equal(runtimeStatus.recentBuilderInvocations[0].adapter_key, "dry-run");
  assert.equal(runtimeStatus.recentBuilderInvocations[0].side_effect_mode, "NONE");

  const released = await store.releaseExecutionLease({
    executionAttemptId: String(claim.executionAttempt.id),
    leaseToken: String(claim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });
  assert.equal(released.executionAttempt.status, "RELEASED");

  await pool.query(
    `UPDATE capability_switches
        SET enabled = false,
            reason = 'CI verification complete',
            updated_by = 'ci'
      WHERE scope_type = 'PROJECT'
        AND project_id = $1
        AND capability = 'AI_DISPATCH'`,
    [projectId],
  );

  const globalCapabilities = await pool.query(
    `SELECT capability, enabled
       FROM capability_switches
      WHERE scope_type = 'GLOBAL'
        AND capability IN ('AI_DISPATCH', 'AUTOMATED_WRITE')
      ORDER BY capability`,
  );
  assert.equal(globalCapabilities.rows.length, 2);
  assert.equal(globalCapabilities.rows.every((row) => row.enabled === false), true);

  console.log("Controlled builder runtime invariants verified successfully.");
} finally {
  await pool.end();
}
