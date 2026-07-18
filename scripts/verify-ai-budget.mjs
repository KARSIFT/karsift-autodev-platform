import assert from "node:assert/strict";

import pg from "pg";

import { ExtendedPostgresControlPlaneStore } from "../dist/store/extended-postgres-store.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString: databaseUrl });
const store = new ExtendedPostgresControlPlaneStore(pool);
const actor = { type: "SYSTEM", id: "ci-budget-verifier" };
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
      slug: `ci-budget-${suffix}`.slice(0, 63),
      name: "CI Budget Project",
      repositoryFullName: `KARSIFT/ci-budget-${suffix}`,
      defaultBranch: "main",
      integrationBranch: "develop",
    },
    actor,
  );
  const projectId = String(project.id);

  const contractBundle = await store.createChangeContract({
    projectId,
    stableId: `CI-BUDGET-${suffix}`,
    content: {
      objective: "verify AI budget execution gating",
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
    rationale: "CI budget authorization",
    actor,
  });
  assert.equal(authorization.authorized, true);

  async function createEligibleWork(name, priority = "P2") {
    const task = await store.createTask({
      projectId,
      changeContractVersionId: versionId,
      title: name,
      description: `Budget verification work: ${name}`,
      priority,
      actor,
    });
    const work = await store.createWorkQueueItem({
      projectId,
      taskId: String(task.id),
      priority,
      executionPolicy: "IMMEDIATE",
      scheduledFor: null,
      idempotencyKey: `budget:${projectId}:${task.id}`,
      actor,
    });
    const validation = await store.validateWorkQueueItem({
      workQueueItemId: String(work.id),
      actor,
    });
    assert.equal(validation.validation.outcome, "VALID");
    assert.equal(validation.workItem.status, "ELIGIBLE");
    return {
      task,
      work: validation.workItem,
      workQueueItemId: String(work.id),
    };
  }

  const deterministic = await createEligibleWork("Deterministic zero-cost work", "P0");
  const deterministicApproval = await store.authorizeWorkBudget({
    workQueueItemId: deterministic.workQueueItemId,
    executionClass: "DETERMINISTIC",
    estimatedMaxCostMicrousd: 0,
    actor,
  });
  assert.equal(deterministicApproval.decision.decision, "APPROVED");
  assert.equal(deterministicApproval.decision.reason_code, "NO_AI_REQUIRED");
  assert.equal(deterministicApproval.reservation, null);

  const deterministicClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "deterministic-worker",
    leaseSeconds: 300,
    actor,
  });
  assert.notEqual(deterministicClaim, null);
  assert.equal(deterministicClaim.executionAttempt.provider_dispatch_decision_id, null);
  const deterministicCompletion = await store.completeExecutionLease({
    executionAttemptId: String(deterministicClaim.executionAttempt.id),
    leaseToken: String(deterministicClaim.executionAttempt.lease_token),
    outcome: "SUCCEEDED",
    details: { deterministic: true },
    actor,
  });
  assert.equal(deterministicCompletion.executionAttempt.status, "SUCCEEDED");

  const aiWork = await createEligibleWork("AI work without policy", "P1");
  const missingPolicy = await store.authorizeWorkBudget({
    workQueueItemId: aiWork.workQueueItemId,
    executionClass: "AI_TIER_1",
    estimatedMaxCostMicrousd: 100_000,
    actor,
  });
  assert.equal(missingPolicy.decision.decision, "DENIED");
  assert.equal(missingPolicy.decision.reason_code, "BUDGET_POLICY_MISSING");
  assert.equal(missingPolicy.reservation, null);

  const noBudgetClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "ai-worker-without-budget",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(noBudgetClaim, null);

  const policy = await store.upsertAiBudgetPolicy({
    projectId,
    monthlyLimitMicrousd: 1_000_000,
    perWorkLimitMicrousd: 600_000,
    maxAiTier: 2,
    enabled: true,
    actor,
  });
  assert.equal(policy.enabled, true);

  const tierDenied = await store.authorizeWorkBudget({
    workQueueItemId: aiWork.workQueueItemId,
    executionClass: "AI_TIER_3",
    estimatedMaxCostMicrousd: 100_000,
    actor,
  });
  assert.equal(tierDenied.decision.reason_code, "EXECUTION_CLASS_NOT_ALLOWED");

  const perWorkDenied = await store.authorizeWorkBudget({
    workQueueItemId: aiWork.workQueueItemId,
    executionClass: "AI_TIER_2",
    estimatedMaxCostMicrousd: 600_001,
    actor,
  });
  assert.equal(perWorkDenied.decision.reason_code, "PER_WORK_LIMIT_EXCEEDED");

  const aiApproval = await store.authorizeWorkBudget({
    workQueueItemId: aiWork.workQueueItemId,
    executionClass: "AI_TIER_2",
    estimatedMaxCostMicrousd: 600_000,
    actor,
  });
  assert.equal(aiApproval.decision.decision, "APPROVED");
  assert.equal(aiApproval.decision.reason_code, "BUDGET_RESERVED");
  assert.equal(aiApproval.reservation.status, "RESERVED");

  const overflowWork = await createEligibleWork("Monthly overflow work", "P2");
  const overflowDecision = await store.authorizeWorkBudget({
    workQueueItemId: overflowWork.workQueueItemId,
    executionClass: "AI_TIER_2",
    estimatedMaxCostMicrousd: 500_000,
    actor,
  });
  assert.equal(overflowDecision.decision.decision, "DEFERRED");
  assert.equal(overflowDecision.decision.reason_code, "PERIOD_BUDGET_EXHAUSTED");

  const aiClaimWhileDisabled = await store.claimExecutionLease({
    projectId,
    leaseOwner: "ai-worker-while-disabled",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(
    aiClaimWhileDisabled,
    null,
    "budget approval must not activate AI_DISPATCH capability",
  );

  const aiStateBeforeRelease = await pool.query(
    "SELECT state_version FROM work_queue_items WHERE id = $1",
    [aiWork.workQueueItemId],
  );
  await store.setWorkQueueEligibility({
    workQueueItemId: aiWork.workQueueItemId,
    expectedStateVersion: aiStateBeforeRelease.rows[0].state_version,
    eligible: false,
    waitingReason: "BUDGET",
    actor,
  });

  const staleReservation = await pool.query(
    "SELECT status FROM ai_budget_reservations WHERE id = $1",
    [aiApproval.reservation.id],
  );
  assert.equal(
    staleReservation.rows[0].status,
    "RELEASED",
    "queue state changes must release stale uncommitted reservations",
  );

  const overflowRebudget = await store.authorizeWorkBudget({
    workQueueItemId: overflowWork.workQueueItemId,
    executionClass: "AI_TIER_2",
    estimatedMaxCostMicrousd: 500_000,
    actor,
  });
  assert.equal(overflowRebudget.decision.decision, "APPROVED");
  assert.equal(overflowRebudget.reservation.status, "RESERVED");

  await store.upsertProviderRoutingPolicy({
    projectId,
    executionClass: "AI_TIER_2",
    capability: "CODE_BUILDER",
    providerKeys: ["ci-budget-builder"],
    enabled: true,
    actor,
  });
  await store.recordProviderCapacityObservation({
    projectId,
    providerKey: "ci-budget-builder",
    capability: "CODE_BUILDER",
    status: "HEALTHY",
    ttlSeconds: 300,
    quotaResetAt: null,
    details: { source: "ci-budget-verifier" },
    actor,
  });
  const providerReady = await store.evaluateProviderDispatch({
    workQueueItemId: overflowWork.workQueueItemId,
    capability: "CODE_BUILDER",
    actor,
  });
  assert.equal(providerReady.outcome, "READY");

  const providerReadyButDisabled = await store.claimExecutionLease({
    projectId,
    leaseOwner: "ai-worker-provider-ready-capability-disabled",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(
    providerReadyButDisabled,
    null,
    "provider readiness and budget approval must not activate AI_DISPATCH",
  );

  await pool.query(
    `INSERT INTO capability_switches(
       scope_type, project_id, capability, enabled, reason, updated_by
     ) VALUES ('PROJECT', $1, 'AI_DISPATCH', true, 'CI-only budget lifecycle verification', 'ci')`,
    [projectId],
  );

  const aiClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "ci-ai-worker",
    leaseSeconds: 300,
    actor,
  });
  assert.notEqual(
    aiClaim,
    null,
    "AI work must be claimable only after budget, provider, and capability gates pass",
  );
  assert.equal(aiClaim.workItem.id, overflowWork.workQueueItemId);
  assert.equal(
    String(aiClaim.executionAttempt.provider_dispatch_decision_id),
    String(providerReady.id),
  );

  const committedReservation = await pool.query(
    "SELECT status, execution_attempt_id FROM ai_budget_reservations WHERE id = $1",
    [overflowRebudget.reservation.id],
  );
  assert.equal(committedReservation.rows[0].status, "COMMITTED");
  assert.equal(
    String(committedReservation.rows[0].execution_attempt_id),
    String(aiClaim.executionAttempt.id),
  );

  await expectRejected(
    () =>
      store.completeExecutionLease({
        executionAttemptId: String(aiClaim.executionAttempt.id),
        leaseToken: String(aiClaim.executionAttempt.lease_token),
        outcome: "SUCCEEDED",
        details: { premature: true },
        actor,
      }),
    "AI attempts must not complete before budget settlement",
  );

  await expectRejected(
    () =>
      store.settleAiBudgetReservation({
        executionAttemptId: String(aiClaim.executionAttempt.id),
        actualCostMicrousd: 500_001,
        actor,
      }),
    "actual AI cost must not exceed the reserved maximum",
  );

  const settlement = await store.settleAiBudgetReservation({
    executionAttemptId: String(aiClaim.executionAttempt.id),
    actualCostMicrousd: 400_000,
    actor,
  });
  assert.equal(settlement.status, "SETTLED");
  assert.equal(Number(settlement.actual_cost_microusd), 400_000);

  const aiCompletion = await store.completeExecutionLease({
    executionAttemptId: String(aiClaim.executionAttempt.id),
    leaseToken: String(aiClaim.executionAttempt.lease_token),
    outcome: "SUCCEEDED",
    details: { settled: true },
    actor,
  });
  assert.equal(aiCompletion.executionAttempt.status, "SUCCEEDED");

  const concurrentOne = await createEligibleWork("Concurrent reservation one", "P2");
  const concurrentTwo = await createEligibleWork("Concurrent reservation two", "P2");

  const [decisionOne, decisionTwo] = await Promise.all([
    store.authorizeWorkBudget({
      workQueueItemId: concurrentOne.workQueueItemId,
      executionClass: "AI_TIER_2",
      estimatedMaxCostMicrousd: 400_000,
      actor,
    }),
    store.authorizeWorkBudget({
      workQueueItemId: concurrentTwo.workQueueItemId,
      executionClass: "AI_TIER_2",
      estimatedMaxCostMicrousd: 400_000,
      actor,
    }),
  ]);

  const outcomes = [decisionOne.decision.decision, decisionTwo.decision.decision].sort();
  assert.deepEqual(
    outcomes,
    ["APPROVED", "DEFERRED"],
    "project policy locking must prevent concurrent monthly-budget overcommit",
  );

  const approvedConcurrent =
    decisionOne.decision.decision === "APPROVED" ? decisionOne : decisionTwo;
  assert.equal(approvedConcurrent.reservation.status, "RESERVED");

  await expectRejected(
    () =>
      pool.query(
        "UPDATE ai_budget_decisions SET reason_code = 'NO_AI_REQUIRED' WHERE id = $1",
        [approvedConcurrent.decision.id],
      ),
    "budget decisions must be append-only",
  );

  const budgetStatus = await store.getProjectAiBudgetStatus(projectId);
  assert.equal(budgetStatus.aiBudgetPolicy.project_id, projectId);
  assert.equal(
    Number(budgetStatus.aiBudgetUsage.current_period_consumed_microusd),
    800_000,
    "current period usage must include settled actual cost plus live reservations",
  );

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
    `SELECT enabled
       FROM capability_switches
      WHERE scope_type = 'GLOBAL'
        AND capability = 'AI_DISPATCH'`,
  );
  assert.equal(globalCapabilities.rows[0].enabled, false);

  console.log("AI Budget Governor and reservation invariants verified successfully.");
} finally {
  await pool.end();
}
