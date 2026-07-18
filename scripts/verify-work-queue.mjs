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
const actor = { type: "SYSTEM", id: "ci-queue-verifier" };
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

async function approveDeterministicBudget(workQueueItemId) {
  const result = await store.authorizeWorkBudget({
    workQueueItemId,
    executionClass: "DETERMINISTIC",
    estimatedMaxCostMicrousd: 0,
    actor,
  });
  assert.equal(result.decision.decision, "APPROVED");
  assert.equal(result.decision.reason_code, "NO_AI_REQUIRED");
  assert.equal(result.reservation, null);
}

try {
  const project = await store.createProject(
    {
      slug: `ci-queue-${suffix}`.slice(0, 63),
      name: "CI Queue Project",
      repositoryFullName: `KARSIFT/ci-queue-${suffix}`,
      defaultBranch: "main",
      integrationBranch: "develop",
    },
    actor,
  );
  const projectId = String(project.id);

  const contractBundle = await store.createChangeContract({
    projectId,
    stableId: `CI-QUEUE-${suffix}`,
    content: {
      objective: "verify duplicate-safe work queue",
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
  const version = contractBundle.version;
  assert.equal(typeof version, "object");
  const versionId = String(version.id);

  const authorization = await store.recordChangeContractAuthorization({
    changeContractId: String(contractBundle.contract.id),
    action: "AUTHORIZE",
    rationale: "CI queue authorization",
    actor,
  });
  assert.equal(authorization.authorized, true);

  const task = await store.createTask({
    projectId,
    changeContractVersionId: versionId,
    title: "Queue verification task",
    description: "Exercise execution leases",
    priority: "P1",
    actor,
  });
  const taskId = String(task.id);
  const idempotencyKey = `ci:${projectId}:${taskId}`;

  const workItem = await store.createWorkQueueItem({
    projectId,
    taskId,
    priority: "P1",
    executionPolicy: "IMMEDIATE",
    scheduledFor: null,
    idempotencyKey,
    actor,
  });
  const workQueueItemId = String(workItem.id);
  assert.equal(workItem.status, "QUEUED");

  const initialValidation = await store.validateWorkQueueItem({
    workQueueItemId,
    actor,
  });
  assert.equal(initialValidation.validation.outcome, "VALID");
  assert.equal(initialValidation.workItem.status, "ELIGIBLE");

  const noBudgetClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "worker-before-budget",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(noBudgetClaim, null, "work without an exact-state budget decision must not be leased");

  await approveDeterministicBudget(workQueueItemId);

  const firstClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "worker-one",
    leaseSeconds: 300,
    actor,
  });
  assert.notEqual(firstClaim, null, "budget-approved eligible item must be claimable");
  const firstAttempt = firstClaim.executionAttempt;
  assert.equal(firstAttempt.status, "ACTIVE");
  assert.equal(firstAttempt.attempt_number, 1);
  assert.equal(firstAttempt.idempotency_key, idempotencyKey);

  const noSecondClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "worker-two",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(noSecondClaim, null, "active lease must remove item from eligibility");

  await expectRejected(
    () =>
      pool.query(
        `INSERT INTO execution_attempts(
           work_queue_item_id,
           project_id,
           attempt_number,
           idempotency_key,
           lease_owner,
           lease_expires_at
         ) VALUES ($1, $2, 99, $3, 'duplicate-worker', now() + interval '5 minutes')`,
        [workQueueItemId, projectId, idempotencyKey],
      ),
    "database must reject an unauthorized duplicate active execution attempt",
  );

  await expectRejected(
    () =>
      store.heartbeatExecutionLease({
        executionAttemptId: String(firstAttempt.id),
        leaseToken: "00000000-0000-0000-0000-000000000000",
        leaseSeconds: 300,
        actor,
      }),
    "stale or incorrect lease token must not extend execution authority",
  );

  const heartbeat = await store.heartbeatExecutionLease({
    executionAttemptId: String(firstAttempt.id),
    leaseToken: String(firstAttempt.lease_token),
    leaseSeconds: 300,
    actor,
  });
  assert.equal(heartbeat.status, "ACTIVE");

  const released = await store.releaseExecutionLease({
    executionAttemptId: String(firstAttempt.id),
    leaseToken: String(firstAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });
  assert.equal(released.workItem.status, "ELIGIBLE");
  assert.equal(released.executionAttempt.status, "RELEASED");

  const releaseValidation = await store.validateWorkQueueItem({
    workQueueItemId,
    actor,
  });
  assert.equal(releaseValidation.validation.outcome, "VALID");
  await approveDeterministicBudget(workQueueItemId);

  const secondClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "worker-two",
    leaseSeconds: 300,
    actor,
  });
  assert.notEqual(secondClaim, null);
  const secondAttempt = secondClaim.executionAttempt;
  assert.equal(secondAttempt.attempt_number, 2);
  assert.equal(secondAttempt.idempotency_key, idempotencyKey);

  await pool.query(
    "UPDATE execution_attempts SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [secondAttempt.id],
  );

  const recoverySweep = await store.claimExecutionLease({
    projectId,
    leaseOwner: "worker-three",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(
    recoverySweep,
    null,
    "expired recovery must invalidate prior freshness and budget evidence",
  );

  const recoveryValidation = await store.validateWorkQueueItem({
    workQueueItemId,
    actor,
  });
  assert.equal(recoveryValidation.validation.outcome, "VALID");
  await approveDeterministicBudget(workQueueItemId);

  const recoveredClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "worker-three",
    leaseSeconds: 300,
    actor,
  });
  assert.notEqual(recoveredClaim, null, "revalidated and rebudgeted work must be reclaimable");
  const thirdAttempt = recoveredClaim.executionAttempt;
  assert.equal(thirdAttempt.attempt_number, 3);
  assert.equal(thirdAttempt.idempotency_key, idempotencyKey);

  const expired = await pool.query(
    "SELECT status FROM execution_attempts WHERE id = $1",
    [secondAttempt.id],
  );
  assert.equal(expired.rows[0].status, "EXPIRED");

  const completed = await store.completeExecutionLease({
    executionAttemptId: String(thirdAttempt.id),
    leaseToken: String(thirdAttempt.lease_token),
    outcome: "SUCCEEDED",
    details: { verified: true },
    actor,
  });
  assert.equal(completed.workItem.status, "COMPLETED");
  assert.equal(completed.executionAttempt.status, "SUCCEEDED");

  const afterCompletion = await store.claimExecutionLease({
    projectId,
    leaseOwner: "worker-four",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(afterCompletion, null);

  const secondTask = await store.createTask({
    projectId,
    changeContractVersionId: versionId,
    title: "Duplicate idempotency task",
    description: "Must reject reused project idempotency key",
    priority: "P2",
    actor,
  });
  await expectRejected(
    () =>
      store.createWorkQueueItem({
        projectId,
        taskId: String(secondTask.id),
        priority: "P2",
        executionPolicy: "IMMEDIATE",
        scheduledFor: null,
        idempotencyKey,
        actor,
      }),
    "project-scoped idempotency keys must be unique",
  );

  const activeCount = await pool.query(
    `SELECT count(*)::integer AS count
       FROM execution_attempts
      WHERE work_queue_item_id = $1 AND status = 'ACTIVE'`,
    [workQueueItemId],
  );
  assert.equal(activeCount.rows[0].count, 0);

  console.log("Work queue and execution lease invariants verified successfully.");
} finally {
  await pool.end();
}
