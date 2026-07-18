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
const actor = { type: "SYSTEM", id: "ci-freshness-verifier" };
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
      slug: `ci-fresh-${suffix}`.slice(0, 63),
      name: "CI Freshness Project",
      repositoryFullName: `KARSIFT/ci-fresh-${suffix}`,
      defaultBranch: "main",
      integrationBranch: "develop",
    },
    actor,
  );
  const projectId = String(project.id);

  const contractBundle = await store.createChangeContract({
    projectId,
    stableId: `CI-FRESH-${suffix}`,
    content: { objective: "verify freshness gating" },
    actor,
  });
  const contractId = String(contractBundle.contract.id);
  const versionOneId = String(contractBundle.version.id);

  const taskOne = await store.createTask({
    projectId,
    changeContractVersionId: versionOneId,
    title: "Freshness verification task",
    description: "Must not run without current authority",
    priority: "P1",
    actor,
  });

  const workOne = await store.createWorkQueueItem({
    projectId,
    taskId: String(taskOne.id),
    priority: "P1",
    executionPolicy: "IMMEDIATE",
    scheduledFor: null,
    idempotencyKey: `fresh:${projectId}:${taskOne.id}`,
    actor,
  });
  const workOneId = String(workOne.id);

  const unauthorized = await store.validateWorkQueueItem({
    workQueueItemId: workOneId,
    actor,
  });
  assert.equal(unauthorized.validation.outcome, "BLOCKED");
  assert.equal(unauthorized.validation.reason_code, "CONTRACT_NOT_AUTHORIZED");
  assert.equal(unauthorized.workItem.status, "BLOCKED");
  assert.equal(unauthorized.workItem.waiting_reason, "FOUNDER_DECISION");

  const claimWithoutAuthority = await store.claimExecutionLease({
    projectId,
    leaseOwner: "worker-before-authority",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(claimWithoutAuthority, null);

  await pool.query(
    "UPDATE change_contracts SET status = 'AUTHORIZED' WHERE id = $1",
    [contractId],
  );

  const authorized = await store.validateWorkQueueItem({
    workQueueItemId: workOneId,
    actor,
  });
  assert.equal(authorized.validation.outcome, "VALID");
  assert.equal(authorized.workItem.status, "ELIGIBLE");

  const firstClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "worker-one",
    leaseSeconds: 300,
    actor,
  });
  assert.notEqual(firstClaim, null);

  const firstRelease = await store.releaseExecutionLease({
    executionAttemptId: String(firstClaim.executionAttempt.id),
    leaseToken: String(firstClaim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });
  assert.equal(firstRelease.workItem.status, "ELIGIBLE");

  const staleValidationClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "worker-with-old-validation",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(
    staleValidationClaim,
    null,
    "queue state changes must invalidate prior validation evidence",
  );

  const retryValidation = await store.validateWorkQueueItem({
    workQueueItemId: workOneId,
    actor,
  });
  assert.equal(retryValidation.validation.outcome, "VALID");

  const secondClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "worker-two",
    leaseSeconds: 300,
    actor,
  });
  assert.notEqual(secondClaim, null);

  await store.releaseExecutionLease({
    executionAttemptId: String(secondClaim.executionAttempt.id),
    leaseToken: String(secondClaim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });

  const versionTwo = await store.appendChangeContractVersion({
    contractId,
    content: { objective: "newer authorized contract version" },
    actor,
  });
  assert.equal(versionTwo.version, 2);

  const stale = await store.validateWorkQueueItem({
    workQueueItemId: workOneId,
    actor,
  });
  assert.equal(stale.validation.outcome, "STALE");
  assert.equal(stale.validation.reason_code, "CONTRACT_VERSION_STALE");
  assert.equal(stale.workItem.status, "BLOCKED");
  assert.equal(stale.workItem.waiting_reason, "POLICY");

  const staleClaim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "worker-stale",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(staleClaim, null);

  const taskTwo = await store.createTask({
    projectId,
    changeContractVersionId: String(versionTwo.id),
    title: "Current contract task",
    description: "Validate current version revocation race",
    priority: "P1",
    actor,
  });
  const workTwo = await store.createWorkQueueItem({
    projectId,
    taskId: String(taskTwo.id),
    priority: "P1",
    executionPolicy: "IMMEDIATE",
    scheduledFor: null,
    idempotencyKey: `fresh:${projectId}:${taskTwo.id}`,
    actor,
  });
  const workTwoId = String(workTwo.id);

  const currentValidation = await store.validateWorkQueueItem({
    workQueueItemId: workTwoId,
    actor,
  });
  assert.equal(currentValidation.validation.outcome, "VALID");

  await pool.query(
    "UPDATE change_contracts SET status = 'CANCELLED' WHERE id = $1",
    [contractId],
  );

  const revokedAfterValidation = await store.claimExecutionLease({
    projectId,
    leaseOwner: "worker-after-revocation",
    leaseSeconds: 300,
    actor,
  });
  assert.equal(
    revokedAfterValidation,
    null,
    "claim must re-check continuing authority after validation",
  );

  const superseded = await store.validateWorkQueueItem({
    workQueueItemId: workTwoId,
    actor,
  });
  assert.equal(superseded.validation.outcome, "SUPERSEDED");
  assert.equal(superseded.validation.reason_code, "CONTRACT_TERMINATED");
  assert.equal(superseded.workItem.status, "SUPERSEDED");

  const validationId = String(currentValidation.validation.id);
  await expectRejected(
    () =>
      pool.query(
        "UPDATE work_validation_runs SET reason_code = 'PROJECT_INACTIVE' WHERE id = $1",
        [validationId],
      ),
    "validation evidence must be append-only",
  );

  console.log("Freshness and continuing-authority invariants verified successfully.");
} finally {
  await pool.end();
}
