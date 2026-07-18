import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import pg from "pg";

import { BuilderAdapterRegistry } from "../dist/agents/builder-adapter.js";
import { BuilderRuntimeService } from "../dist/services/builder-runtime-service.js";
import { ExtendedPostgresControlPlaneStore } from "../dist/store/extended-postgres-store.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

class CountingDryRunAdapter {
  key = "dry-run";
  sideEffectMode = "NONE";
  executionCount = 0;
  inputs = [];

  async execute(input) {
    this.executionCount += 1;
    this.inputs.push(input);
    await delay(100);
    return {
      outcome: "SUCCEEDED",
      turnsUsed: 0,
      commandsUsed: 0,
      durationMs: 100,
      summary: "Concurrent dispatch probe completed without external side effects.",
      evidence: {
        dryRun: true,
        concurrencyProbe: true,
        externalProviderCalled: false,
        repositoryMutated: false,
        dispatchIdempotencyKey: input.dispatchIdempotencyKey,
      },
    };
  }
}

const pool = new Pool({ connectionString: databaseUrl });
const store = new ExtendedPostgresControlPlaneStore(pool);
const adapter = new CountingDryRunAdapter();
const service = new BuilderRuntimeService(
  store,
  store,
  new BuilderAdapterRegistry([adapter]),
);
const actor = { type: "SYSTEM", id: "ci-builder-dispatch-verifier" };
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
      slug: `ci-dispatch-${suffix}`.slice(0, 63),
      name: "CI Atomic Builder Dispatch Project",
      repositoryFullName: `KARSIFT/ci-dispatch-${suffix}`,
      defaultBranch: "main",
      integrationBranch: "develop",
    },
    actor,
  );
  const projectId = String(project.id);

  const contractBundle = await store.createChangeContract({
    projectId,
    stableId: `CI-DISPATCH-${suffix}`,
    content: {
      objective: "verify atomic builder dispatch and provider revalidation",
      acceptanceCriteria: [
        "concurrent run requests execute the adapter at most once",
        "latest provider capacity is checked immediately before execution",
      ],
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
    rationale: "CI atomic builder dispatch authorization",
    actor,
  });
  assert.equal(authorization.authorized, true);

  await store.upsertAiBudgetPolicy({
    projectId,
    monthlyLimitMicrousd: 2_000_000,
    perWorkLimitMicrousd: 500_000,
    maxAiTier: 3,
    enabled: true,
    actor,
  });
  await store.upsertProviderRoutingPolicy({
    projectId,
    executionClass: "AI_TIER_2",
    capability: "CODE_BUILDER",
    providerKeys: ["ci-atomic-builder"],
    enabled: true,
    actor,
  });
  await store.recordProviderCapacityObservation({
    projectId,
    providerKey: "ci-atomic-builder",
    capability: "CODE_BUILDER",
    status: "HEALTHY",
    ttlSeconds: 600,
    quotaResetAt: null,
    details: { source: "initial-ready" },
    actor,
  });

  await pool.query(
    `INSERT INTO capability_switches(
       scope_type, project_id, capability, enabled, reason, updated_by
     ) VALUES (
       'PROJECT', $1, 'AI_DISPATCH', true,
       'CI-only atomic dispatch lifecycle verification', 'ci'
     )`,
    [projectId],
  );

  async function createPreparedInvocation(name, priority = "P1") {
    const task = await store.createTask({
      projectId,
      changeContractVersionId: versionId,
      title: name,
      description: `Atomic dispatch verification: ${name}`,
      priority,
      actor,
    });
    const work = await store.createWorkQueueItem({
      projectId,
      taskId: String(task.id),
      priority,
      executionPolicy: "IMMEDIATE",
      scheduledFor: null,
      idempotencyKey: `dispatch:${projectId}:${task.id}`,
      actor,
    });
    const workQueueItemId = String(work.id);
    const validation = await store.validateWorkQueueItem({ workQueueItemId, actor });
    assert.equal(validation.validation.outcome, "VALID");

    const budget = await store.authorizeWorkBudget({
      workQueueItemId,
      executionClass: "AI_TIER_2",
      estimatedMaxCostMicrousd: 100_000,
      actor,
    });
    assert.equal(budget.decision.decision, "APPROVED");

    const dispatch = await store.evaluateProviderDispatch({
      workQueueItemId,
      capability: "CODE_BUILDER",
      actor,
    });
    assert.equal(dispatch.outcome, "READY");

    const claim = await store.claimExecutionLease({
      projectId,
      leaseOwner: `execution-${name}`,
      leaseSeconds: 600,
      actor,
    });
    assert.notEqual(claim, null);
    assert.equal(String(claim.workItem.id), workQueueItemId);

    const pack = await store.createTaskContextPack({
      executionAttemptId: String(claim.executionAttempt.id),
      leaseToken: String(claim.executionAttempt.lease_token),
      baseBranch: "develop",
      baseCommitSha: "c".repeat(40),
      relevantPaths: ["src/agents", "src/services", "src/store"],
      actor,
    });
    const prepared = await store.prepareBuilderInvocation({
      executionAttemptId: String(claim.executionAttempt.id),
      leaseToken: String(claim.executionAttempt.lease_token),
      limits: {
        maxTurns: 2,
        retryBudget: 1,
        commandBudget: 10,
        timeoutSeconds: 60,
      },
      actor,
    });

    return { task, workQueueItemId, claim, pack, prepared };
  }

  const primary = await createPreparedInvocation("Concurrent adapter dispatch", "P0");
  const invocationId = String(primary.prepared.invocation.id);

  await expectRejected(
    () =>
      pool.query(
        `UPDATE builder_invocations
            SET status = 'RUNNING',
                state_version = state_version + 1,
                started_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [invocationId],
      ),
    "database must reject invocation start without an active READY dispatch claim",
  );

  const unavailable = await store.recordProviderCapacityObservation({
    projectId,
    providerKey: "ci-atomic-builder",
    capability: "CODE_BUILDER",
    status: "UNAVAILABLE",
    ttlSeconds: 300,
    quotaResetAt: null,
    details: { source: "newer-unavailable" },
    actor,
  });

  const blocked = await service.runBuilderInvocation({
    builderInvocationId: invocationId,
    actor,
  });
  assert.equal(blocked.executed, false);
  assert.equal(blocked.reason, "PROVIDER_UNAVAILABLE");
  assert.equal(blocked.dispatchRevalidation.outcome, "WAIT");
  assert.equal(
    String(blocked.dispatchRevalidation.capacity_observation_id),
    String(unavailable.id),
    "the latest provider observation must supersede the originally linked READY observation",
  );
  assert.equal(adapter.executionCount, 0);

  const latestHealthy = await store.recordProviderCapacityObservation({
    projectId,
    providerKey: "ci-atomic-builder",
    capability: "CODE_BUILDER",
    status: "HEALTHY",
    ttlSeconds: 300,
    quotaResetAt: null,
    details: { source: "newer-healthy" },
    actor,
  });

  const [runOne, runTwo] = await Promise.all([
    service.runBuilderInvocation({ builderInvocationId: invocationId, actor }),
    service.runBuilderInvocation({ builderInvocationId: invocationId, actor }),
  ]);
  const runs = [runOne, runTwo];
  assert.equal(
    runs.filter((run) => run.executed === true).length,
    1,
    "two concurrent run requests must execute the adapter exactly once",
  );
  assert.equal(
    runs.filter((run) => run.executed === false).length,
    1,
    "the losing concurrent request must not execute the adapter",
  );
  assert.equal(adapter.executionCount, 1);
  assert.equal(adapter.inputs.length, 1);
  assert.equal(
    adapter.inputs[0].dispatchIdempotencyKey,
    `builder-dispatch:${primary.prepared.plan.plan_hash}`,
  );

  const successfulRun = runs.find((run) => run.executed === true);
  assert.equal(successfulRun.invocation.status, "SUCCEEDED");
  assert.equal(successfulRun.dispatchClaim.status, "COMPLETED");
  assert.equal(successfulRun.dispatchRevalidation.outcome, "READY");
  assert.equal(
    String(successfulRun.dispatchRevalidation.capacity_observation_id),
    String(latestHealthy.id),
  );

  const repeated = await service.runBuilderInvocation({
    builderInvocationId: invocationId,
    actor,
  });
  assert.equal(repeated.executed, false);
  assert.equal(repeated.reason, "INVOCATION_NOT_DISPATCHABLE");
  assert.equal(adapter.executionCount, 1, "terminal retries must not execute the adapter again");

  const primaryClaims = await pool.query(
    `SELECT status, idempotency_key
       FROM builder_dispatch_claims
      WHERE builder_invocation_id = $1
      ORDER BY created_at, id`,
    [invocationId],
  );
  assert.deepEqual(
    primaryClaims.rows.map((row) => row.status).sort(),
    ["COMPLETED", "RELEASED"],
  );
  assert.equal(
    new Set(primaryClaims.rows.map((row) => row.idempotency_key)).size,
    1,
    "all retries for one immutable plan must reuse the same dispatch idempotency key",
  );

  const recovery = await createPreparedInvocation("Dispatch claim expiry recovery", "P1");
  const recoveryInvocationId = String(recovery.prepared.invocation.id);
  const firstClaim = await store.acquireBuilderDispatchClaim({
    builderInvocationId: recoveryInvocationId,
    claimOwner: "recovery-worker-one",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(firstClaim.acquired, true);

  const heartbeat = await store.heartbeatBuilderDispatchClaim({
    builderDispatchClaimId: String(firstClaim.claim.id),
    claimToken: String(firstClaim.claim.claim_token),
    leaseSeconds: 600,
    actor,
  });
  assert.equal(heartbeat.status, "ACTIVE");

  await expectRejected(
    () =>
      store.heartbeatBuilderDispatchClaim({
        builderDispatchClaimId: String(firstClaim.claim.id),
        claimToken: "00000000-0000-0000-0000-000000000000",
        leaseSeconds: 300,
        actor,
      }),
    "a stale dispatch claim token must not extend ownership",
  );

  await pool.query(
    "UPDATE builder_dispatch_claims SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [firstClaim.claim.id],
  );

  const recoveredClaim = await store.acquireBuilderDispatchClaim({
    builderInvocationId: recoveryInvocationId,
    claimOwner: "recovery-worker-two",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(recoveredClaim.acquired, true);
  assert.notEqual(String(recoveredClaim.claim.id), String(firstClaim.claim.id));
  assert.equal(
    recoveredClaim.claim.idempotency_key,
    firstClaim.claim.idempotency_key,
    "claim recovery must preserve the stable dispatch idempotency key",
  );

  const expiredStatus = await pool.query(
    "SELECT status FROM builder_dispatch_claims WHERE id = $1",
    [firstClaim.claim.id],
  );
  assert.equal(expiredStatus.rows[0].status, "EXPIRED");

  const releasedRecoveryClaim = await store.releaseBuilderDispatchClaim({
    builderDispatchClaimId: String(recoveredClaim.claim.id),
    claimToken: String(recoveredClaim.claim.claim_token),
    actor,
  });
  assert.equal(releasedRecoveryClaim.status, "RELEASED");

  await expectRejected(
    () =>
      pool.query(
        "UPDATE builder_dispatch_revalidations SET reason_code = 'PROVIDER_READY' WHERE id = $1",
        [firstClaim.revalidation.id],
      ),
    "builder dispatch revalidation evidence must be append-only",
  );

  await store.releaseExecutionLease({
    executionAttemptId: String(primary.claim.executionAttempt.id),
    leaseToken: String(primary.claim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });
  await store.releaseExecutionLease({
    executionAttemptId: String(recovery.claim.executionAttempt.id),
    leaseToken: String(recovery.claim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });

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

  console.log("Atomic builder dispatch and provider revalidation invariants verified successfully.");
} finally {
  await pool.end();
}
