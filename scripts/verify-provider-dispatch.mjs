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
const actor = { type: "SYSTEM", id: "ci-provider-verifier" };
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
      slug: `ci-provider-${suffix}`.slice(0, 63),
      name: "CI Provider Dispatch Project",
      repositoryFullName: `KARSIFT/ci-provider-${suffix}`,
      defaultBranch: "main",
      integrationBranch: "develop",
    },
    actor,
  );
  const projectId = String(project.id);

  const contractBundle = await store.createChangeContract({
    projectId,
    stableId: `CI-PROVIDER-${suffix}`,
    content: {
      objective: "verify provider dispatch readiness",
      deliverables: ["provider-aware execution evidence"],
      acceptanceCriteria: ["fallback and waiting semantics are deterministic"],
      tests: ["provider lifecycle verifier passes"],
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
    rationale: "CI provider dispatch authorization",
    actor,
  });
  assert.equal(authorization.authorized, true);

  await store.upsertAiBudgetPolicy({
    projectId,
    monthlyLimitMicrousd: 10_000_000,
    perWorkLimitMicrousd: 1_000_000,
    maxAiTier: 4,
    enabled: true,
    actor,
  });

  async function createEligibleWork(name, priority = "P2") {
    const task = await store.createTask({
      projectId,
      changeContractVersionId: versionId,
      title: name,
      description: `Provider verification work: ${name}`,
      priority,
      actor,
    });
    const work = await store.createWorkQueueItem({
      projectId,
      taskId: String(task.id),
      priority,
      executionPolicy: "IMMEDIATE",
      scheduledFor: null,
      idempotencyKey: `provider:${projectId}:${task.id}`,
      actor,
    });
    const validation = await store.validateWorkQueueItem({
      workQueueItemId: String(work.id),
      actor,
    });
    assert.equal(validation.validation.outcome, "VALID");
    return {
      task,
      workQueueItemId: String(work.id),
      idempotencyKey: `provider:${projectId}:${task.id}`,
    };
  }

  const primaryWork = await createEligibleWork("Fallback provider work", "P0");
  const primaryBudget = await store.authorizeWorkBudget({
    workQueueItemId: primaryWork.workQueueItemId,
    executionClass: "AI_TIER_2",
    estimatedMaxCostMicrousd: 200_000,
    actor,
  });
  assert.equal(primaryBudget.decision.decision, "APPROVED");

  const routingV1 = await store.upsertProviderRoutingPolicy({
    projectId,
    executionClass: "AI_TIER_2",
    capability: "CODE_BUILDER",
    providerKeys: ["primary-builder", "fallback-builder"],
    enabled: true,
    actor,
  });
  assert.equal(Number(routingV1.version), 1);

  const missingObservationDecision = await store.evaluateProviderDispatch({
    workQueueItemId: primaryWork.workQueueItemId,
    capability: "CODE_BUILDER",
    actor,
  });
  assert.equal(missingObservationDecision.outcome, "WAIT");
  assert.equal(
    missingObservationDecision.reason_code,
    "PROVIDER_OBSERVATION_MISSING",
  );
  assert.equal(missingObservationDecision.waiting_reason, "PROVIDER_UNAVAILABLE");

  const quotaObservation = await store.recordProviderCapacityObservation({
    projectId,
    providerKey: "primary-builder",
    capability: "CODE_BUILDER",
    status: "QUOTA_EXHAUSTED",
    ttlSeconds: 300,
    quotaResetAt: "2026-07-19T00:00:00.000Z",
    details: { source: "ci", reason: "quota" },
    actor,
  });
  const healthyFallback = await store.recordProviderCapacityObservation({
    projectId,
    providerKey: "fallback-builder",
    capability: "CODE_BUILDER",
    status: "HEALTHY",
    ttlSeconds: 300,
    quotaResetAt: null,
    details: { source: "ci", reason: "healthy-fallback" },
    actor,
  });

  const readyDecision = await store.evaluateProviderDispatch({
    workQueueItemId: primaryWork.workQueueItemId,
    capability: "CODE_BUILDER",
    actor,
  });
  assert.equal(readyDecision.outcome, "READY");
  assert.equal(readyDecision.waiting_reason, "NONE");
  assert.equal(readyDecision.provider_key, "fallback-builder");
  assert.equal(Number(readyDecision.selected_provider_rank), 2);
  assert.equal(
    String(readyDecision.capacity_observation_id),
    String(healthyFallback.id),
  );

  const disabledClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "provider-worker-disabled",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(
    disabledClaim,
    null,
    "provider readiness and budget must not activate AI_DISPATCH",
  );

  await pool.query(
    `INSERT INTO capability_switches(
       scope_type, project_id, capability, enabled, reason, updated_by
     ) VALUES ('PROJECT', $1, 'AI_DISPATCH', true, 'CI-only provider lifecycle verification', 'ci')`,
    [projectId],
  );

  const claim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "provider-worker",
    leaseSeconds: 300,
    actor,
  });
  assert.notEqual(claim, null);
  assert.equal(claim.workItem.id, primaryWork.workQueueItemId);
  assert.equal(
    String(claim.executionAttempt.provider_dispatch_decision_id),
    String(readyDecision.id),
  );

  const pack = await store.createTaskContextPack({
    executionAttemptId: String(claim.executionAttempt.id),
    leaseToken: String(claim.executionAttempt.lease_token),
    baseBranch: "develop",
    baseCommitSha: "a".repeat(40),
    relevantPaths: ["src/provider.ts", " src/worker.ts ", "src/provider.ts"],
    actor,
  });
  assert.equal(
    String(pack.provider_dispatch_decision_id),
    String(readyDecision.id),
  );
  assert.equal(pack.content.schemaVersion, "task-context-pack-v2");
  assert.equal(
    pack.content.evidence.providerDispatch.providerKey,
    "fallback-builder",
  );
  assert.equal(
    pack.content.evidence.providerDispatch.capacityObservation.status,
    "HEALTHY",
  );
  assert.deepEqual(pack.content.evidence.providerDispatch.candidateProviderKeys, [
    "primary-builder",
    "fallback-builder",
  ]);

  const released = await store.releaseExecutionLease({
    executionAttemptId: String(claim.executionAttempt.id),
    leaseToken: String(claim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });
  assert.equal(released.executionAttempt.status, "RELEASED");

  const routingV2 = await store.upsertProviderRoutingPolicy({
    projectId,
    executionClass: "AI_TIER_2",
    capability: "CODE_BUILDER",
    providerKeys: ["fallback-builder", "primary-builder"],
    enabled: true,
    actor,
  });
  assert.equal(Number(routingV2.version), 2);

  const immutablePack = await store.getTaskContextPack(
    String(claim.executionAttempt.id),
  );
  assert.equal(
    immutablePack.content.evidence.providerDispatch.routingPolicyVersion,
    1,
    "later routing edits must not rewrite existing Task Context Pack evidence",
  );

  const latestDecisionWork = await createEligibleWork(
    "Latest dispatch decision enforcement",
    "P1",
  );
  const latestDecisionBudget = await store.authorizeWorkBudget({
    workQueueItemId: latestDecisionWork.workQueueItemId,
    executionClass: "AI_TIER_2",
    estimatedMaxCostMicrousd: 150_000,
    actor,
  });
  assert.equal(latestDecisionBudget.decision.decision, "APPROVED");

  const oldReady = await store.evaluateProviderDispatch({
    workQueueItemId: latestDecisionWork.workQueueItemId,
    capability: "CODE_BUILDER",
    actor,
  });
  assert.equal(oldReady.outcome, "READY");

  await store.recordProviderCapacityObservation({
    projectId,
    providerKey: "fallback-builder",
    capability: "CODE_BUILDER",
    status: "UNAVAILABLE",
    ttlSeconds: 300,
    quotaResetAt: null,
    details: { source: "ci", reason: "forced-unavailable" },
    actor,
  });
  await store.recordProviderCapacityObservation({
    projectId,
    providerKey: "primary-builder",
    capability: "CODE_BUILDER",
    status: "QUOTA_EXHAUSTED",
    ttlSeconds: 300,
    quotaResetAt: "2026-07-19T00:00:00.000Z",
    details: { source: "ci", reason: "forced-quota" },
    actor,
  });

  const waitDecision = await store.evaluateProviderDispatch({
    workQueueItemId: latestDecisionWork.workQueueItemId,
    capability: "CODE_BUILDER",
    actor,
  });
  assert.equal(waitDecision.outcome, "WAIT");
  assert.equal(waitDecision.waiting_reason, "PROVIDER_UNAVAILABLE");
  assert.equal(
    waitDecision.reason_code,
    "PROVIDER_UNAVAILABLE",
    "the updated routing order makes fallback-builder the primary wait reason",
  );

  const blockedClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "provider-worker-after-wait",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(
    blockedClaim,
    null,
    "a newer WAIT decision must invalidate an older READY decision for claiming",
  );

  const evidence = await pool.query(
    `SELECT work_item.state_version,
            validation.id AS validation_id,
            auth_evidence.id AS authorization_id,
            budget.id AS budget_id
       FROM work_queue_items work_item
       JOIN tasks task
         ON task.id = work_item.task_id
        AND task.project_id = work_item.project_id
       JOIN change_contract_versions contract_version
         ON contract_version.id = task.change_contract_version_id
        AND contract_version.project_id = work_item.project_id
       JOIN LATERAL (
         SELECT id
           FROM work_validation_runs
          WHERE work_queue_item_id = work_item.id
            AND project_id = work_item.project_id
            AND queue_state_version = work_item.state_version
            AND outcome = 'VALID'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) validation ON true
       JOIN LATERAL (
         SELECT id
           FROM change_contract_authorization_decisions
          WHERE change_contract_version_id = contract_version.id
            AND project_id = work_item.project_id
            AND decision IN ('AUTHORIZED', 'REVOKED')
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) auth_evidence ON true
       JOIN LATERAL (
         SELECT id
           FROM ai_budget_decisions
          WHERE work_queue_item_id = work_item.id
            AND project_id = work_item.project_id
            AND queue_state_version = work_item.state_version
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) budget ON true
      WHERE work_item.id = $1`,
    [latestDecisionWork.workQueueItemId],
  );
  const exactEvidence = evidence.rows[0];

  await expectRejected(
    () =>
      pool.query(
        `INSERT INTO execution_attempts(
           work_queue_item_id,
           project_id,
           attempt_number,
           idempotency_key,
           lease_owner,
           lease_expires_at,
           claim_queue_state_version,
           work_validation_run_id,
           change_contract_authorization_decision_id,
           ai_budget_decision_id,
           provider_dispatch_decision_id
         ) VALUES (
           $1, $2, 99, $3, 'direct-provider-worker', now() + interval '5 minutes',
           $4, $5, $6, $7, $8
         )`,
        [
          latestDecisionWork.workQueueItemId,
          projectId,
          latestDecisionWork.idempotencyKey,
          exactEvidence.state_version,
          exactEvidence.validation_id,
          exactEvidence.authorization_id,
          exactEvidence.budget_id,
          oldReady.id,
        ],
      ),
    "database must reject an older READY decision after a newer WAIT decision exists",
  );

  const missingPolicyWork = await createEligibleWork("Missing routing policy", "P2");
  await store.authorizeWorkBudget({
    workQueueItemId: missingPolicyWork.workQueueItemId,
    executionClass: "AI_TIER_4",
    estimatedMaxCostMicrousd: 50_000,
    actor,
  });
  const missingPolicyDecision = await store.evaluateProviderDispatch({
    workQueueItemId: missingPolicyWork.workQueueItemId,
    capability: "CODE_BUILDER",
    actor,
  });
  assert.equal(
    missingPolicyDecision.reason_code,
    "PROVIDER_ROUTING_POLICY_MISSING",
  );

  const staleWork = await createEligibleWork("Stale provider observation", "P2");
  await store.authorizeWorkBudget({
    workQueueItemId: staleWork.workQueueItemId,
    executionClass: "AI_TIER_1",
    estimatedMaxCostMicrousd: 50_000,
    actor,
  });
  await store.upsertProviderRoutingPolicy({
    projectId,
    executionClass: "AI_TIER_1",
    capability: "CODE_BUILDER",
    providerKeys: ["stale-builder"],
    enabled: true,
    actor,
  });
  await pool.query(
    `INSERT INTO ai_provider_capacity_observations(
       project_id, provider_key, capability, status, details, observed_by, observed_at, expires_at
     ) VALUES (
       $1, 'stale-builder', 'CODE_BUILDER', 'HEALTHY', '{}'::jsonb, 'ci',
       now() - interval '2 minutes', now() - interval '1 minute'
     )`,
    [projectId],
  );
  const staleDecision = await store.evaluateProviderDispatch({
    workQueueItemId: staleWork.workQueueItemId,
    capability: "CODE_BUILDER",
    actor,
  });
  assert.equal(staleDecision.reason_code, "PROVIDER_OBSERVATION_STALE");
  assert.equal(staleDecision.waiting_reason, "PROVIDER_UNAVAILABLE");

  await expectRejected(
    () =>
      pool.query(
        "UPDATE ai_provider_capacity_observations SET status = 'HEALTHY' WHERE id = $1",
        [quotaObservation.id],
      ),
    "provider capacity observations must be append-only",
  );
  await expectRejected(
    () =>
      pool.query(
        "UPDATE ai_provider_dispatch_decisions SET reason_code = 'PROVIDER_READY' WHERE id = $1",
        [waitDecision.id],
      ),
    "provider dispatch decisions must be append-only",
  );

  const providerStatus = await store.getProjectProviderDispatchStatus(projectId);
  assert.equal(providerStatus.providerRoutingPolicies.length >= 2, true);
  assert.equal(providerStatus.recentProviderDispatchDecisions.length >= 4, true);

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

  console.log("Provider capacity and dispatch readiness invariants verified successfully.");
} finally {
  await pool.end();
}
