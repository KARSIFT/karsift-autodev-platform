import assert from "node:assert/strict";

import pg from "pg";

import { sha256Json } from "../dist/domain/stable-json.js";
import { ExtendedPostgresControlPlaneStore } from "../dist/store/extended-postgres-store.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString: databaseUrl });
const store = new ExtendedPostgresControlPlaneStore(pool);
const actor = { type: "SYSTEM", id: "ci-context-pack-verifier" };
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
      slug: `ci-context-${suffix}`.slice(0, 63),
      name: "CI Task Context Pack Project",
      repositoryFullName: `KARSIFT/ci-context-${suffix}`,
      defaultBranch: "main",
      integrationBranch: "develop",
    },
    actor,
  );
  const projectId = String(project.id);

  const contractBundle = await store.createChangeContract({
    projectId,
    stableId: `CI-CONTEXT-${suffix}`,
    content: {
      objective: "Build a deterministic execution handoff",
      deliverables: ["Immutable pack", "Exact evidence binding"],
      acceptanceCriteria: ["Evidence IDs match the lease", "Hash is reproducible"],
      interfaces: ["Control Plane internal API"],
      tests: ["Deterministic unit tests", "PostgreSQL lifecycle verifier"],
      risks: ["Stale evidence", "Prompt drift"],
      prohibitedScope: ["AI provider invocation", "Production deployment"],
      expectedEvidence: ["Exact contract hash", "Exact budget decision ID"],
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
  const contractVersionId = String(contractBundle.version.id);

  const authorization = await store.recordChangeContractAuthorization({
    changeContractId: contractId,
    action: "AUTHORIZE",
    rationale: "CI context-pack authorization",
    actor,
  });
  assert.equal(authorization.authorized, true);

  const task = await store.createTask({
    projectId,
    changeContractVersionId: contractVersionId,
    title: "Create exact handoff pack",
    description: "Verify immutable execution context",
    priority: "P1",
    actor,
  });
  const taskId = String(task.id);

  const work = await store.createWorkQueueItem({
    projectId,
    taskId,
    priority: "P1",
    executionPolicy: "IMMEDIATE",
    scheduledFor: null,
    idempotencyKey: `context:${projectId}:${taskId}`,
    actor,
  });
  const workQueueItemId = String(work.id);

  const validation = await store.validateWorkQueueItem({
    workQueueItemId,
    actor,
  });
  assert.equal(validation.validation.outcome, "VALID");

  const budget = await store.authorizeWorkBudget({
    workQueueItemId,
    executionClass: "DETERMINISTIC",
    estimatedMaxCostMicrousd: 0,
    actor,
  });
  assert.equal(budget.decision.decision, "APPROVED");

  const claim = await store.claimExecutionLease({
    projectId,
    leaseOwner: "ci-context-worker",
    leaseSeconds: 300,
    actor,
  });
  assert.notEqual(claim, null);
  const attempt = claim.executionAttempt;
  const attemptId = String(attempt.id);
  const leaseToken = String(attempt.lease_token);

  assert.equal(
    String(attempt.work_validation_run_id),
    String(validation.validation.id),
    "lease must snapshot the exact freshness validation used at claim time",
  );
  assert.equal(
    String(attempt.change_contract_authorization_decision_id),
    String(authorization.decision.id),
    "lease must snapshot the exact authorization decision used at claim time",
  );
  assert.equal(
    String(attempt.ai_budget_decision_id),
    String(budget.decision.id),
    "lease must snapshot the exact budget decision used at claim time",
  );
  assert.equal(
    Number(attempt.claim_queue_state_version),
    Number(validation.validation.queue_state_version),
  );

  await expectRejected(
    () =>
      store.createTaskContextPack({
        executionAttemptId: attemptId,
        leaseToken: "00000000-0000-0000-0000-000000000000",
        baseBranch: "develop",
        baseCommitSha: "a".repeat(40),
        relevantPaths: ["src/store/task-context-pack-store.ts"],
        actor,
      }),
    "incorrect lease proof must not create a Task Context Pack",
  );

  const pack = await store.createTaskContextPack({
    executionAttemptId: attemptId,
    leaseToken,
    baseBranch: "develop",
    baseCommitSha: "a".repeat(40),
    relevantPaths: [
      "src/store/task-context-pack-store.ts",
      "src/domain/task-context-pack.ts",
      "src/store/task-context-pack-store.ts",
    ],
    actor,
  });

  assert.equal(String(pack.execution_attempt_id), attemptId);
  assert.equal(String(pack.work_validation_run_id), String(validation.validation.id));
  assert.equal(
    String(pack.change_contract_authorization_decision_id),
    String(authorization.decision.id),
  );
  assert.equal(String(pack.ai_budget_decision_id), String(budget.decision.id));
  assert.equal(String(pack.change_contract_version_id), contractVersionId);
  assert.equal(String(pack.contract_content_hash), String(contractBundle.version.content_hash));
  assert.equal(pack.content_hash, sha256Json(pack.content));
  assert.deepEqual(pack.content.repositorySnapshot.relevantPaths, [
    "src/domain/task-context-pack.ts",
    "src/store/task-context-pack-store.ts",
  ]);
  assert.equal(pack.content.objective, "Build a deterministic execution handoff");
  assert.deepEqual(pack.content.deliverables, [
    "Immutable pack",
    "Exact evidence binding",
  ]);
  assert.equal(
    JSON.stringify(pack.content).includes(leaseToken),
    false,
    "Task Context Pack content must never contain the execution lease token",
  );

  const retry = await store.createTaskContextPack({
    executionAttemptId: attemptId,
    leaseToken,
    baseBranch: "develop",
    baseCommitSha: "a".repeat(40),
    relevantPaths: [
      "src/domain/task-context-pack.ts",
      "src/store/task-context-pack-store.ts",
    ],
    actor,
  });
  assert.equal(String(retry.id), String(pack.id));

  await expectRejected(
    () =>
      store.createTaskContextPack({
        executionAttemptId: attemptId,
        leaseToken,
        baseBranch: "develop",
        baseCommitSha: "b".repeat(40),
        relevantPaths: ["src/domain/task-context-pack.ts"],
        actor,
      }),
    "an existing immutable pack must reject repository snapshot drift",
  );

  await expectRejected(
    () =>
      pool.query(
        "UPDATE task_context_packs SET base_branch = 'main' WHERE id = $1",
        [pack.id],
      ),
    "Task Context Pack rows must reject UPDATE operations",
  );
  await expectRejected(
    () => pool.query("DELETE FROM task_context_packs WHERE id = $1", [pack.id]),
    "Task Context Pack rows must reject DELETE operations",
  );

  const completed = await store.completeExecutionLease({
    executionAttemptId: attemptId,
    leaseToken,
    outcome: "SUCCEEDED",
    details: { contextPackId: pack.id },
    actor,
  });
  assert.equal(completed.executionAttempt.status, "SUCCEEDED");

  const retryAfterCompletion = await store.createTaskContextPack({
    executionAttemptId: attemptId,
    leaseToken,
    baseBranch: "develop",
    baseCommitSha: "a".repeat(40),
    relevantPaths: [
      "src/domain/task-context-pack.ts",
      "src/store/task-context-pack-store.ts",
    ],
    actor,
  });
  assert.equal(String(retryAfterCompletion.id), String(pack.id));

  const secondTask = await store.createTask({
    projectId,
    changeContractVersionId: contractVersionId,
    title: "Reject evidence-free direct attempt",
    description: "Prove execution attempt evidence trigger",
    priority: "P2",
    actor,
  });
  const secondWork = await store.createWorkQueueItem({
    projectId,
    taskId: String(secondTask.id),
    priority: "P2",
    executionPolicy: "IMMEDIATE",
    scheduledFor: null,
    idempotencyKey: `context-direct:${projectId}:${secondTask.id}`,
    actor,
  });
  const secondWorkId = String(secondWork.id);

  const secondValidation = await store.validateWorkQueueItem({
    workQueueItemId: secondWorkId,
    actor,
  });
  assert.equal(secondValidation.validation.outcome, "VALID");
  const secondBudget = await store.authorizeWorkBudget({
    workQueueItemId: secondWorkId,
    executionClass: "DETERMINISTIC",
    estimatedMaxCostMicrousd: 0,
    actor,
  });
  assert.equal(secondBudget.decision.decision, "APPROVED");

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
         ) VALUES ($1, $2, 1, $3, 'direct-worker', now() + interval '5 minutes')`,
        [
          secondWorkId,
          projectId,
          `context-direct:${projectId}:${secondTask.id}`,
        ],
      ),
    "PostgreSQL must reject new execution attempts without exact evidence snapshots",
  );

  const storedPack = await store.getTaskContextPack(attemptId);
  assert.equal(String(storedPack.id), String(pack.id));

  const projectStatus = await store.getProjectTaskContextPackStatus(projectId);
  assert.equal(Number(projectStatus.taskContextPackCount), 1);

  const globalCapabilities = await pool.query(
    `SELECT capability, enabled
       FROM capability_switches
      WHERE scope_type = 'GLOBAL'
      ORDER BY capability`,
  );
  assert.equal(
    globalCapabilities.rows.every((row) => row.enabled === false),
    true,
    "all permanent global autonomous capability switches must remain disabled",
  );

  console.log("Execution evidence and Task Context Pack invariants verified successfully.");
} finally {
  await pool.end();
}
