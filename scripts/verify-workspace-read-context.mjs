import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";

import { LocalGitWorkspaceAdapter } from "../dist/repository/local-git-workspace-adapter.js";
import { RepositoryWorkspaceAdapterRegistry } from "../dist/repository/repository-workspace-adapter.js";
import { WorkspaceReadContextCapturer } from "../dist/repository/workspace-read-context-capturer.js";
import { RepositoryWorkspaceService } from "../dist/services/repository-workspace-service.js";
import { WorkspaceReadContextService } from "../dist/services/workspace-read-context-service.js";
import { ExtendedPostgresControlPlaneStore } from "../dist/store/extended-postgres-store.js";
import { PostgresRepositoryWorkspaceStore } from "../dist/store/repository-workspace-store.js";
import { PostgresWorkspaceCommandStore } from "../dist/store/workspace-command-store.js";
import { PostgresWorkspaceMutationStore } from "../dist/store/workspace-mutation-store.js";
import { PostgresWorkspaceReadContextStore } from "../dist/store/workspace-read-context-store.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

async function run(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
        reject(new Error(result.stderr.trim() || `${command} exited ${code}`));
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

const pool = new Pool({ connectionString: databaseUrl });
const coreStore = new ExtendedPostgresControlPlaneStore(pool);
const workspaceStore = new PostgresRepositoryWorkspaceStore(pool);
const commandStore = new PostgresWorkspaceCommandStore(pool);
const mutationStore = new PostgresWorkspaceMutationStore(pool);
const readContextStore = new PostgresWorkspaceReadContextStore(pool);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "karsift-read-context-ci-"));
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
const capturer = new WorkspaceReadContextCapturer(workspaceRoot);
const readContextService = new WorkspaceReadContextService(readContextStore, capturer);
const actor = { type: "SYSTEM", id: "ci-workspace-read-context-verifier" };
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const emptyHash = createHash("sha256").update("").digest("hex");

try {
  await mkdir(path.join(sourceRepository, "src", "nested"), { recursive: true });
  await writeFile(path.join(sourceRepository, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(sourceRepository, "src", "b.ts"), "export const b = 2;\n");
  await writeFile(path.join(sourceRepository, "src", "c.ts"), "export const c = 3;\n");
  await writeFile(
    path.join(sourceRepository, "src", "nested", "d.ts"),
    "export const d = 4;\n",
  );
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
      slug: `ci-read-context-${suffix}`.slice(0, 63),
      name: "CI Workspace Read Context Project",
      repositoryFullName: `KARSIFT/ci-read-context-${suffix}`,
      defaultBranch: "main",
      integrationBranch: "develop",
    },
    actor,
  );
  const projectId = String(project.id);
  const contractBundle = await coreStore.createChangeContract({
    projectId,
    stableId: `CI-READ-CONTEXT-${suffix}`,
    content: {
      objective: "verify immutable workspace read context snapshots",
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
  assert.equal(
    (
      await coreStore.recordChangeContractAuthorization({
        changeContractId: contractId,
        action: "AUTHORIZE",
        rationale: "CI workspace read context authorization",
        actor,
      })
    ).authorized,
    true,
  );
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
    providerKeys: ["ci-read-context-builder"],
    enabled: true,
    actor,
  });
  await coreStore.recordProviderCapacityObservation({
    projectId,
    providerKey: "ci-read-context-builder",
    capability: "CODE_BUILDER",
    status: "HEALTHY",
    ttlSeconds: 3600,
    quotaResetAt: null,
    details: { source: "ci-workspace-read-context-verifier" },
    actor,
  });
  await pool.query(
    `INSERT INTO capability_switches(
       scope_type, project_id, capability, enabled, reason, updated_by
     ) VALUES ('PROJECT', $1, 'AI_DISPATCH', true, 'CI-only read context verification', 'ci')`,
    [projectId],
  );
  await pool.query(
    `INSERT INTO capability_switches(
       scope_type, project_id, capability, enabled, reason, updated_by
     ) VALUES ('PROJECT', $1, 'AUTOMATED_WRITE', true, 'CI-only read context verification', 'ci')`,
    [projectId],
  );

  const task = await coreStore.createTask({
    projectId,
    changeContractVersionId: versionId,
    title: "Immutable workspace read context",
    description: "Verify bounded source snapshot capture",
    priority: "P0",
    actor,
  });
  const work = await coreStore.createWorkQueueItem({
    projectId,
    taskId: String(task.id),
    priority: "P0",
    executionPolicy: "IMMEDIATE",
    scheduledFor: null,
    idempotencyKey: `workspace-read-context:${projectId}:${task.id}`,
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
    leaseOwner: `workspace-read-context-${suffix}`,
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
    limits: { maxTurns: 2, retryBudget: 1, commandBudget: 10, timeoutSeconds: 60 },
    actor,
  });
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

  await expectRejected(
    () =>
      readContextStore.prepareWorkspaceReadContext({
        repositoryWorkspaceId: workspaceId,
        requestedPaths: ["docs"],
        actor,
      }),
    "out-of-scope snapshot requests must fail closed",
  );
  await expectRejected(
    () =>
      readContextStore.prepareWorkspaceReadContext({
        repositoryWorkspaceId: workspaceId,
        requestedPaths: ["src/.env"],
        actor,
      }),
    "protected snapshot paths must fail closed",
  );

  const prepared = await readContextStore.prepareWorkspaceReadContext({
    repositoryWorkspaceId: workspaceId,
    requestedPaths: ["src"],
    actor,
  });
  const readRunId = String(prepared.run.id);
  const retry = await readContextStore.prepareWorkspaceReadContext({
    repositoryWorkspaceId: workspaceId,
    requestedPaths: ["src"],
    actor,
  });
  assert.equal(String(retry.run.id), readRunId);
  await Promise.all([
    readContextService.capture({ workspaceReadContextRunId: readRunId, actor }),
    readContextService.capture({ workspaceReadContextRunId: readRunId, actor }),
  ]);
  const captured = await readContextStore.getWorkspaceReadContextRun(readRunId);
  assert.equal(captured.status, "CAPTURED");
  assert.equal(captured.snapshot.file_count, 4);
  assert.deepEqual(
    captured.snapshot.files.map((file) => file.path),
    ["src/a.ts", "src/b.ts", "src/c.ts", "src/nested/d.ts"],
  );
  assert.match(captured.snapshot.snapshot_hash, /^[a-f0-9]{64}$/);

  await commandStore.createWorkspaceCommandPolicy({
    projectId,
    policyKey: "ci-read-context",
    version: 1,
    enabled: true,
    policy: {
      purposes: ["INSPECT"],
      rules: [{ executable: "node", allowedArguments: [["--version"], ["-p", "1+1"]] }],
      environmentAllowlist: [],
      maxTimeoutMs: 5000,
      maxOutputBytes: 1024,
      maxCommandsPerWorkspace: 5,
    },
    actor,
  });

  const commandPrepared = await commandStore.prepareWorkspaceCommand({
    repositoryWorkspaceId: workspaceId,
    policyKey: "ci-read-context",
    purpose: "INSPECT",
    executable: "node",
    arguments: ["--version"],
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    environment: {},
    actor,
  });
  const commandRunId = String(commandPrepared.run.id);
  assert.equal((await commandStore.claimWorkspaceCommandRun(commandRunId, actor)).claimed, true);
  const commandBlockedCapture = await readContextStore.prepareWorkspaceReadContext({
    repositoryWorkspaceId: workspaceId,
    requestedPaths: ["src/a.ts"],
    actor,
  });
  await expectRejected(
    () =>
      readContextStore.claimWorkspaceReadContextRun(
        String(commandBlockedCapture.run.id),
        actor,
      ),
    "active commands must block source capture",
  );
  await commandStore.completeWorkspaceCommandRun({
    workspaceCommandRunId: commandRunId,
    runnerResult: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      stdoutSha256: emptyHash,
      stderrSha256: emptyHash,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      errorCode: null,
    },
    actor,
  });
  await readContextService.capture({
    workspaceReadContextRunId: String(commandBlockedCapture.run.id),
    actor,
  });

  const mutationPrepared = await mutationStore.prepareWorkspaceMutation({
    repositoryWorkspaceId: workspaceId,
    operations: [
      {
        type: "CREATE",
        path: "src/new.ts",
        expectedBeforeHash: null,
        content: "export const created = true;\n",
      },
    ],
    actor,
  });
  const mutationRunId = String(mutationPrepared.run.id);
  assert.equal((await mutationStore.claimWorkspaceMutationRun(mutationRunId, actor)).claimed, true);
  const mutationBlockedCapture = await readContextStore.prepareWorkspaceReadContext({
    repositoryWorkspaceId: workspaceId,
    requestedPaths: ["src/b.ts"],
    actor,
  });
  await expectRejected(
    () =>
      readContextStore.claimWorkspaceReadContextRun(
        String(mutationBlockedCapture.run.id),
        actor,
      ),
    "active mutations must block source capture",
  );
  await mutationStore.completeWorkspaceMutationRun({
    workspaceMutationRunId: mutationRunId,
    outcome: "FAILED",
    durationMs: 1,
    pathEvidence: [],
    errorCode: "CI_RELEASE",
    actor,
  });
  await readContextService.capture({
    workspaceReadContextRunId: String(mutationBlockedCapture.run.id),
    actor,
  });

  const activeCapture = await readContextStore.prepareWorkspaceReadContext({
    repositoryWorkspaceId: workspaceId,
    requestedPaths: ["src/c.ts"],
    actor,
  });
  const activeCaptureRunId = String(activeCapture.run.id);
  assert.equal(
    (await readContextStore.claimWorkspaceReadContextRun(activeCaptureRunId, actor)).claimed,
    true,
  );
  const commandDuringCapture = await commandStore.prepareWorkspaceCommand({
    repositoryWorkspaceId: workspaceId,
    policyKey: "ci-read-context",
    purpose: "INSPECT",
    executable: "node",
    arguments: ["-p", "1+1"],
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    environment: {},
    actor,
  });
  await expectRejected(
    () =>
      commandStore.claimWorkspaceCommandRun(String(commandDuringCapture.run.id), actor),
    "active capture must block command start",
  );
  const mutationDuringCapture = await mutationStore.prepareWorkspaceMutation({
    repositoryWorkspaceId: workspaceId,
    operations: [
      {
        type: "CREATE",
        path: "src/blocked.ts",
        expectedBeforeHash: null,
        content: "export const blocked = true;\n",
      },
    ],
    actor,
  });
  await expectRejected(
    () =>
      mutationStore.claimWorkspaceMutationRun(String(mutationDuringCapture.run.id), actor),
    "active capture must block mutation start",
  );
  await readContextStore.failWorkspaceReadContext({
    workspaceReadContextRunId: activeCaptureRunId,
    actor,
  });
  assert.equal(
    (await commandStore.claimWorkspaceCommandRun(String(commandDuringCapture.run.id), actor)).claimed,
    true,
  );
  await commandStore.completeWorkspaceCommandRun({
    workspaceCommandRunId: String(commandDuringCapture.run.id),
    runnerResult: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      stdoutSha256: emptyHash,
      stderrSha256: emptyHash,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      errorCode: null,
    },
    actor,
  });
  assert.equal(
    (await mutationStore.claimWorkspaceMutationRun(String(mutationDuringCapture.run.id), actor)).claimed,
    true,
  );
  await mutationStore.completeWorkspaceMutationRun({
    workspaceMutationRunId: String(mutationDuringCapture.run.id),
    outcome: "FAILED",
    durationMs: 1,
    pathEvidence: [],
    errorCode: "CI_RELEASE",
    actor,
  });

  await expectRejected(
    () =>
      pool.query(
        "UPDATE workspace_read_context_requests SET workspace_path = workspace_path || '-mutated' WHERE id = $1",
        [prepared.request.id],
      ),
    "workspace read context requests must be immutable",
  );
  await expectRejected(
    () =>
      pool.query(
        "UPDATE workspace_read_context_snapshots SET total_bytes = total_bytes + 1 WHERE workspace_read_context_run_id = $1",
        [readRunId],
      ),
    "workspace read context snapshots must be immutable",
  );

  await coreStore.releaseExecutionLease({
    executionAttemptId: String(claim.executionAttempt.id),
    leaseToken: String(claim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });
  await pool.query(
    `UPDATE capability_switches
        SET enabled = false,
            reason = 'CI workspace read context verification complete',
            updated_by = 'ci'
      WHERE scope_type = 'PROJECT'
        AND project_id = $1
        AND capability IN ('AI_DISPATCH', 'AUTOMATED_WRITE')`,
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

  console.log("Immutable workspace read context invariants verified successfully.");
} finally {
  await pool.end();
  await rm(tempRoot, { recursive: true, force: true });
}
