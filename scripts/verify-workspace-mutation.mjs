import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";

import { AtomicWorkspaceMutationApplier } from "../dist/repository/atomic-workspace-mutation-applier.js";
import { LocalGitWorkspaceAdapter } from "../dist/repository/local-git-workspace-adapter.js";
import { RepositoryWorkspaceAdapterRegistry } from "../dist/repository/repository-workspace-adapter.js";
import { RepositoryWorkspaceService } from "../dist/services/repository-workspace-service.js";
import { WorkspaceMutationService } from "../dist/services/workspace-mutation-service.js";
import { ExtendedPostgresControlPlaneStore } from "../dist/store/extended-postgres-store.js";
import { PostgresRepositoryWorkspaceStore } from "../dist/store/repository-workspace-store.js";
import { PostgresWorkspaceMutationStore } from "../dist/store/workspace-mutation-store.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${code}`}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
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

async function pathExists(value) {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

const pool = new Pool({ connectionString: databaseUrl });
const coreStore = new ExtendedPostgresControlPlaneStore(pool);
const workspaceStore = new PostgresRepositoryWorkspaceStore(pool);
const mutationStore = new PostgresWorkspaceMutationStore(pool);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "karsift-mutation-ci-"));
const sourceRoot = path.join(tempRoot, "sources");
const workspaceRoot = path.join(tempRoot, "workspaces");
const sourceRepositoryPath = "fixture-repo";
const sourceRepository = path.join(sourceRoot, sourceRepositoryPath);
const workspaceAdapter = new LocalGitWorkspaceAdapter({ sourceRoot, workspaceRoot });
const workspaceService = new RepositoryWorkspaceService(
  workspaceStore,
  new RepositoryWorkspaceAdapterRegistry([workspaceAdapter]),
  { sourceRoot, workspaceRoot },
);
const mutationService = new WorkspaceMutationService(
  mutationStore,
  new AtomicWorkspaceMutationApplier(workspaceRoot),
);
const actor = { type: "SYSTEM", id: "ci-workspace-mutation-verifier" };
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

try {
  await mkdir(path.join(sourceRepository, "src"), { recursive: true });
  await writeFile(path.join(sourceRepository, "src", "update.txt"), "update-before\n");
  await writeFile(path.join(sourceRepository, "src", "delete.txt"), "delete-before\n");
  await writeFile(path.join(sourceRepository, "src", "rollback-a.txt"), "rollback-a-before\n");
  await writeFile(path.join(sourceRepository, "src", "rollback-b.txt"), "rollback-b-before\n");
  await run("git", ["init", "-b", "develop", sourceRepository]);
  await run("git", ["-C", sourceRepository, "config", "user.name", "KARSIFT CI"]);
  await run("git", ["-C", sourceRepository, "config", "user.email", "ci@example.invalid"]);
  await run("git", ["-C", sourceRepository, "add", "."]);
  await run("git", ["-C", sourceRepository, "commit", "-m", "fixture base"]);
  const baseCommitSha = (
    await run("git", ["-C", sourceRepository, "rev-parse", "HEAD"])
  ).stdout.trim();

  const project = await coreStore.createProject(
    {
      slug: `ci-mutation-${suffix}`.slice(0, 63),
      name: "CI Workspace Mutation Project",
      repositoryFullName: `KARSIFT/ci-mutation-${suffix}`,
      defaultBranch: "main",
      integrationBranch: "develop",
    },
    actor,
  );
  const projectId = String(project.id);
  const contractBundle = await coreStore.createChangeContract({
    projectId,
    stableId: `CI-MUTATION-${suffix}`,
    content: {
      objective: "verify structured workspace mutations",
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
  const authorization = await coreStore.recordChangeContractAuthorization({
    changeContractId: contractId,
    action: "AUTHORIZE",
    rationale: "CI workspace mutation authorization",
    actor,
  });
  assert.equal(authorization.authorized, true);

  await coreStore.upsertAiBudgetPolicy({
    projectId,
    monthlyLimitMicrousd: 5_000_000,
    perWorkLimitMicrousd: 500_000,
    maxAiTier: 3,
    enabled: true,
    actor,
  });
  await coreStore.upsertProviderRoutingPolicy({
    projectId,
    executionClass: "AI_TIER_2",
    capability: "CODE_BUILDER",
    providerKeys: ["ci-mutation-builder"],
    enabled: true,
    actor,
  });
  await coreStore.recordProviderCapacityObservation({
    projectId,
    providerKey: "ci-mutation-builder",
    capability: "CODE_BUILDER",
    status: "HEALTHY",
    ttlSeconds: 3600,
    quotaResetAt: null,
    details: { source: "ci-workspace-mutation-verifier" },
    actor,
  });
  await pool.query(
    `INSERT INTO capability_switches(
       scope_type, project_id, capability, enabled, reason, updated_by
     ) VALUES (
       'PROJECT', $1, 'AI_DISPATCH', true,
       'CI-only workspace mutation verification', 'ci'
     )`,
    [projectId],
  );

  async function setAutomatedWrite(enabled, reason) {
    const updated = await pool.query(
      `UPDATE capability_switches
          SET enabled = $2,
              reason = $3,
              updated_by = 'ci',
              updated_at = now()
        WHERE scope_type = 'PROJECT'
          AND project_id = $1
          AND capability = 'AUTOMATED_WRITE'
        RETURNING id`,
      [projectId, enabled, reason],
    );
    if ((updated.rowCount ?? 0) === 0) {
      await pool.query(
        `INSERT INTO capability_switches(
           scope_type, project_id, capability, enabled, reason, updated_by
         ) VALUES ('PROJECT', $1, 'AUTOMATED_WRITE', $2, $3, 'ci')`,
        [projectId, enabled, reason],
      );
    }
  }

  const task = await coreStore.createTask({
    projectId,
    changeContractVersionId: versionId,
    title: "Structured workspace mutation",
    description: "Verify bounded text-file mutation authority",
    priority: "P0",
    actor,
  });
  const work = await coreStore.createWorkQueueItem({
    projectId,
    taskId: String(task.id),
    priority: "P0",
    executionPolicy: "IMMEDIATE",
    scheduledFor: null,
    idempotencyKey: `workspace-mutation:${projectId}:${task.id}`,
    actor,
  });
  const workQueueItemId = String(work.id);
  assert.equal(
    (await coreStore.validateWorkQueueItem({ workQueueItemId, actor })).validation.outcome,
    "VALID",
  );
  assert.equal(
    (
      await coreStore.authorizeWorkBudget({
        workQueueItemId,
        executionClass: "AI_TIER_2",
        estimatedMaxCostMicrousd: 100_000,
        actor,
      })
    ).decision.decision,
    "APPROVED",
  );
  assert.equal(
    (
      await coreStore.evaluateProviderDispatch({
        workQueueItemId,
        capability: "CODE_BUILDER",
        actor,
      })
    ).outcome,
    "READY",
  );
  const claim = await coreStore.claimExecutionLease({
    projectId,
    leaseOwner: `workspace-mutation-${suffix}`,
    leaseSeconds: 900,
    actor,
  });
  assert.notEqual(claim, null);
  await coreStore.createTaskContextPack({
    executionAttemptId: String(claim.executionAttempt.id),
    leaseToken: String(claim.executionAttempt.lease_token),
    baseBranch: "develop",
    baseCommitSha,
    relevantPaths: ["src"],
    actor,
  });
  const builder = await coreStore.prepareBuilderInvocation({
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

  await setAutomatedWrite(true, "CI materialize writable mutation workspace");
  const preparedWorkspace = await workspaceStore.prepareRepositoryWorkspace({
    builderInvocationId: String(builder.invocation.id),
    mode: "WRITE",
    actor,
  });
  const workspaceId = String(preparedWorkspace.workspace.id);
  await workspaceService.materialize({
    repositoryWorkspaceId: workspaceId,
    sourceRepositoryPath,
    actor,
  });
  const workspace = await workspaceStore.getRepositoryWorkspace(workspaceId);
  const workspacePath = String(workspace.workspace_path);
  assert.equal(await pathExists(workspacePath), true);

  const updateBefore = await readFile(path.join(workspacePath, "src", "update.txt"));
  const deleteBefore = await readFile(path.join(workspacePath, "src", "delete.txt"));
  const operations = [
    {
      type: "CREATE",
      path: "src/create.txt",
      expectedBeforeHash: null,
      content: "created-by-mutation\n",
    },
    {
      type: "UPDATE",
      path: "src/update.txt",
      expectedBeforeHash: sha256(updateBefore),
      content: "update-after\n",
    },
    {
      type: "DELETE",
      path: "src/delete.txt",
      expectedBeforeHash: sha256(deleteBefore),
      content: null,
    },
  ];

  await setAutomatedWrite(false, "CI prove mutation preparation write gate");
  await expectRejected(
    () =>
      mutationStore.prepareWorkspaceMutation({
        repositoryWorkspaceId: workspaceId,
        operations,
        actor,
      }),
    "mutation preparation must fail while AUTOMATED_WRITE is disabled",
  );
  await setAutomatedWrite(true, "CI execute structured workspace mutations");

  await expectRejected(
    () =>
      mutationStore.prepareWorkspaceMutation({
        repositoryWorkspaceId: workspaceId,
        operations: [
          {
            type: "CREATE",
            path: "outside.txt",
            expectedBeforeHash: null,
            content: "outside\n",
          },
        ],
        actor,
      }),
    "out-of-scope mutation paths must fail closed",
  );

  const prepared = await mutationStore.prepareWorkspaceMutation({
    repositoryWorkspaceId: workspaceId,
    operations,
    actor,
  });
  const mutationRunId = String(prepared.run.id);
  const retry = await mutationStore.prepareWorkspaceMutation({
    repositoryWorkspaceId: workspaceId,
    operations,
    actor,
  });
  assert.equal(String(retry.run.id), mutationRunId);

  await Promise.all([
    mutationService.apply({ workspaceMutationRunId: mutationRunId, actor }),
    mutationService.apply({ workspaceMutationRunId: mutationRunId, actor }),
  ]);
  const applied = await mutationStore.getWorkspaceMutationRun(mutationRunId);
  assert.equal(applied.status, "APPLIED");
  assert.equal(applied.evidence.outcome, "APPLIED");
  assert.equal(applied.evidence.path_evidence.length, 3);
  assert.equal(
    await readFile(path.join(workspacePath, "src", "create.txt"), "utf8"),
    "created-by-mutation\n",
  );
  assert.equal(
    await readFile(path.join(workspacePath, "src", "update.txt"), "utf8"),
    "update-after\n",
  );
  assert.equal(await pathExists(path.join(workspacePath, "src", "delete.txt")), false);
  const evidenceCount = await pool.query(
    "SELECT count(*)::int AS count FROM workspace_mutation_evidence WHERE workspace_mutation_run_id = $1",
    [mutationRunId],
  );
  assert.equal(evidenceCount.rows[0].count, 1);

  const stalePrepared = await mutationStore.prepareWorkspaceMutation({
    repositoryWorkspaceId: workspaceId,
    operations: [
      {
        type: "UPDATE",
        path: "src/update.txt",
        expectedBeforeHash: "a".repeat(64),
        content: "must-not-apply\n",
      },
    ],
    actor,
  });
  const staleRunId = String(stalePrepared.run.id);
  await mutationService.apply({ workspaceMutationRunId: staleRunId, actor });
  const staleFinal = await mutationStore.getWorkspaceMutationRun(staleRunId);
  assert.equal(staleFinal.status, "FAILED");
  assert.equal(staleFinal.evidence.error_code, "PRECONDITION_FAILED");
  assert.equal(
    await readFile(path.join(workspacePath, "src", "update.txt"), "utf8"),
    "update-after\n",
  );

  const gatedPrepared = await mutationStore.prepareWorkspaceMutation({
    repositoryWorkspaceId: workspaceId,
    operations: [
      {
        type: "CREATE",
        path: "src/gated.txt",
        expectedBeforeHash: null,
        content: "gated\n",
      },
    ],
    actor,
  });
  const gatedRunId = String(gatedPrepared.run.id);
  await setAutomatedWrite(false, "CI prove mutation start-time write recheck");
  await expectRejected(
    () => mutationService.apply({ workspaceMutationRunId: gatedRunId, actor }),
    "mutation start must re-check AUTOMATED_WRITE",
  );
  assert.equal((await mutationStore.getWorkspaceMutationRun(gatedRunId)).status, "PREPARED");
  await setAutomatedWrite(true, "CI resume mutation verification");
  await mutationService.apply({ workspaceMutationRunId: gatedRunId, actor });
  assert.equal((await mutationStore.getWorkspaceMutationRun(gatedRunId)).status, "APPLIED");

  const rollbackAPath = path.join(workspacePath, "src", "rollback-a.txt");
  const rollbackBPath = path.join(workspacePath, "src", "rollback-b.txt");
  const rollbackA = await readFile(rollbackAPath);
  const rollbackB = await readFile(rollbackBPath);
  const rollbackPrepared = await mutationStore.prepareWorkspaceMutation({
    repositoryWorkspaceId: workspaceId,
    operations: [
      {
        type: "UPDATE",
        path: "src/rollback-a.txt",
        expectedBeforeHash: sha256(rollbackA),
        content: "rollback-a-after\n",
      },
      {
        type: "UPDATE",
        path: "src/rollback-b.txt",
        expectedBeforeHash: sha256(rollbackB),
        content: "rollback-b-after\n",
      },
    ],
    actor,
  });
  const rollbackRunId = String(rollbackPrepared.run.id);
  const rollbackService = new WorkspaceMutationService(
    mutationStore,
    new AtomicWorkspaceMutationApplier(workspaceRoot, (index) => {
      if (index === 1) {
        throw new Error("injected apply failure");
      }
    }),
  );
  await rollbackService.apply({ workspaceMutationRunId: rollbackRunId, actor });
  const rollbackFinal = await mutationStore.getWorkspaceMutationRun(rollbackRunId);
  assert.equal(rollbackFinal.status, "FAILED");
  assert.equal(await readFile(rollbackAPath, "utf8"), "rollback-a-before\n");
  assert.equal(await readFile(rollbackBPath, "utf8"), "rollback-b-before\n");

  let releaseFirstApply;
  const firstApplyGate = new Promise((resolve) => {
    releaseFirstApply = resolve;
  });
  let firstApplyStarted;
  const firstApplyStartedPromise = new Promise((resolve) => {
    firstApplyStarted = resolve;
  });
  const serializedService = new WorkspaceMutationService(
    mutationStore,
    new AtomicWorkspaceMutationApplier(workspaceRoot, async (index) => {
      if (index === 0) {
        firstApplyStarted();
        await firstApplyGate;
      }
    }),
  );
  const serialOne = await mutationStore.prepareWorkspaceMutation({
    repositoryWorkspaceId: workspaceId,
    operations: [
      {
        type: "CREATE",
        path: "src/serial-one.txt",
        expectedBeforeHash: null,
        content: "one\n",
      },
    ],
    actor,
  });
  const serialTwo = await mutationStore.prepareWorkspaceMutation({
    repositoryWorkspaceId: workspaceId,
    operations: [
      {
        type: "CREATE",
        path: "src/serial-two.txt",
        expectedBeforeHash: null,
        content: "two\n",
      },
    ],
    actor,
  });
  const firstApplyPromise = serializedService.apply({
    workspaceMutationRunId: String(serialOne.run.id),
    actor,
  });
  await firstApplyStartedPromise;
  const secondWhileBusy = await mutationService.apply({
    workspaceMutationRunId: String(serialTwo.run.id),
    actor,
  });
  assert.equal(secondWhileBusy.status, "PREPARED");
  releaseFirstApply();
  await firstApplyPromise;
  await mutationService.apply({
    workspaceMutationRunId: String(serialTwo.run.id),
    actor,
  });
  assert.equal(
    (await mutationStore.getWorkspaceMutationRun(String(serialTwo.run.id))).status,
    "APPLIED",
  );

  await expectRejected(
    () =>
      pool.query(
        "UPDATE workspace_mutation_plans SET total_content_bytes = total_content_bytes + 1 WHERE id = $1",
        [prepared.plan.id],
      ),
    "workspace mutation plans must be immutable",
  );
  await expectRejected(
    () =>
      pool.query(
        "UPDATE workspace_mutation_evidence SET error_code = 'MUTATED' WHERE workspace_mutation_run_id = $1",
        [mutationRunId],
      ),
    "workspace mutation evidence must be immutable",
  );

  const finalized = await workspaceService.finalize({
    repositoryWorkspaceId: workspaceId,
    actor,
  });
  assert.equal(finalized.workspace.status, "FINALIZED");
  assert.equal(finalized.evidence.scope_valid, true);
  assert.equal(await pathExists(workspacePath), false);
  assert.equal(await pathExists(path.join(sourceRepository, "src", "create.txt")), false);
  assert.equal(
    await readFile(path.join(sourceRepository, "src", "update.txt"), "utf8"),
    "update-before\n",
  );

  await coreStore.releaseExecutionLease({
    executionAttemptId: String(claim.executionAttempt.id),
    leaseToken: String(claim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });
  await setAutomatedWrite(false, "CI workspace mutation verification complete");
  await pool.query(
    `UPDATE capability_switches
        SET enabled = false,
            reason = 'CI workspace mutation verification complete',
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

  console.log("Structured workspace mutation invariants verified successfully.");
} finally {
  await pool.end();
  await rm(tempRoot, { recursive: true, force: true });
}
