import assert from "node:assert/strict";
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

import { BoundedWorkspaceCommandRunner } from "../dist/commands/bounded-workspace-command-runner.js";
import { LocalGitWorkspaceAdapter } from "../dist/repository/local-git-workspace-adapter.js";
import { RepositoryWorkspaceAdapterRegistry } from "../dist/repository/repository-workspace-adapter.js";
import { RepositoryWorkspaceService } from "../dist/services/repository-workspace-service.js";
import { WorkspaceCommandService } from "../dist/services/workspace-command-service.js";
import { ExtendedPostgresControlPlaneStore } from "../dist/store/extended-postgres-store.js";
import { PostgresRepositoryWorkspaceStore } from "../dist/store/repository-workspace-store.js";
import { PostgresWorkspaceCommandStore } from "../dist/store/workspace-command-store.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
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
const commandStore = new PostgresWorkspaceCommandStore(pool);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "karsift-command-ci-"));
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
const commandService = new WorkspaceCommandService(
  commandStore,
  new BoundedWorkspaceCommandRunner(workspaceRoot),
);
const actor = { type: "SYSTEM", id: "ci-workspace-command-verifier" };
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

try {
  await mkdir(path.join(sourceRepository, "src"), { recursive: true });
  await writeFile(path.join(sourceRepository, "src", "base.txt"), "base\n");
  await run("git", ["init", "-b", "develop", sourceRepository]);
  await run("git", ["-C", sourceRepository, "config", "user.name", "KARSIFT CI"]);
  await run("git", ["-C", sourceRepository, "config", "user.email", "ci@example.invalid"]);
  await run("git", ["-C", sourceRepository, "add", "."]);
  await run("git", ["-C", sourceRepository, "commit", "-m", "fixture base"]);
  const baseCommitSha = (
    await run("git", ["-C", sourceRepository, "rev-parse", "HEAD"])
  ).stdout.trim();
  assert.match(baseCommitSha, /^[a-f0-9]{40}$/);

  const project = await coreStore.createProject(
    {
      slug: `ci-command-${suffix}`.slice(0, 63),
      name: "CI Workspace Command Project",
      repositoryFullName: `KARSIFT/ci-command-${suffix}`,
      defaultBranch: "main",
      integrationBranch: "develop",
    },
    actor,
  );
  const projectId = String(project.id);

  const contractBundle = await coreStore.createChangeContract({
    projectId,
    stableId: `CI-COMMAND-${suffix}`,
    content: {
      objective: "verify bounded workspace command execution",
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
    rationale: "CI workspace command authorization",
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
    providerKeys: ["ci-command-builder"],
    enabled: true,
    actor,
  });
  await coreStore.recordProviderCapacityObservation({
    projectId,
    providerKey: "ci-command-builder",
    capability: "CODE_BUILDER",
    status: "HEALTHY",
    ttlSeconds: 3600,
    quotaResetAt: null,
    details: { source: "ci-workspace-command-verifier" },
    actor,
  });
  await pool.query(
    `INSERT INTO capability_switches(
       scope_type, project_id, capability, enabled, reason, updated_by
     ) VALUES (
       'PROJECT', $1, 'AI_DISPATCH', true,
       'CI-only workspace command verification', 'ci'
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

  async function createPreparedBuilder(name, relevantPaths) {
    const task = await coreStore.createTask({
      projectId,
      changeContractVersionId: versionId,
      title: name,
      description: `Workspace command verification: ${name}`,
      priority: "P0",
      actor,
    });
    const work = await coreStore.createWorkQueueItem({
      projectId,
      taskId: String(task.id),
      priority: "P0",
      executionPolicy: "IMMEDIATE",
      scheduledFor: null,
      idempotencyKey: `workspace-command:${projectId}:${task.id}`,
      actor,
    });
    const workQueueItemId = String(work.id);
    const validation = await coreStore.validateWorkQueueItem({ workQueueItemId, actor });
    assert.equal(validation.validation.outcome, "VALID");
    const budget = await coreStore.authorizeWorkBudget({
      workQueueItemId,
      executionClass: "AI_TIER_2",
      estimatedMaxCostMicrousd: 100_000,
      actor,
    });
    assert.equal(budget.decision.decision, "APPROVED");
    const dispatch = await coreStore.evaluateProviderDispatch({
      workQueueItemId,
      capability: "CODE_BUILDER",
      actor,
    });
    assert.equal(dispatch.outcome, "READY");
    const claim = await coreStore.claimExecutionLease({
      projectId,
      leaseOwner: `workspace-command-${suffix}`,
      leaseSeconds: 900,
      actor,
    });
    assert.notEqual(claim, null);
    assert.equal(String(claim.workItem.id), workQueueItemId);
    await coreStore.createTaskContextPack({
      executionAttemptId: String(claim.executionAttempt.id),
      leaseToken: String(claim.executionAttempt.lease_token),
      baseBranch: "develop",
      baseCommitSha,
      relevantPaths,
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
    return { claim, builder };
  }

  const countScript = "require('node:fs').appendFileSync('command-count.txt','x')";
  const environmentScript =
    "process.exit(process.env.OPENAI_API_KEY === undefined ? 0 : 9)";
  const outputScript = "process.stdout.write('x'.repeat(10000))";
  const timeoutScript = "setTimeout(() => {}, 5000)";
  const successScript = "process.exit(0)";

  const policy = await commandStore.createWorkspaceCommandPolicy({
    projectId,
    policyKey: "ci-bounded",
    version: 1,
    enabled: true,
    policy: {
      purposes: ["INSPECT", "BUILD", "TEST", "FORMAT_CHECK"],
      rules: [
        {
          executable: "node",
          allowedArguments: [
            ["-e", countScript],
            ["-e", environmentScript],
            ["-e", outputScript],
            ["-e", timeoutScript],
            ["-e", successScript],
            ["--version"],
            ["-p", "1+1"],
          ],
        },
      ],
      environmentAllowlist: ["KARSIFT_COMMAND_TEST"],
      maxTimeoutMs: 10_000,
      maxOutputBytes: 512,
      maxCommandsPerWorkspace: 6,
    },
    actor,
  });
  assert.match(String(policy.policy_hash), /^[a-f0-9]{64}$/);

  const preparedBuilder = await createPreparedBuilder(
    "Bounded command workspace",
    ["command-count.txt"],
  );
  await setAutomatedWrite(true, "CI materialize writable command workspace");
  const preparedWorkspace = await workspaceStore.prepareRepositoryWorkspace({
    builderInvocationId: String(preparedBuilder.builder.invocation.id),
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

  await setAutomatedWrite(false, "CI prove command preparation write gate");
  await expectRejected(
    () =>
      commandStore.prepareWorkspaceCommand({
        repositoryWorkspaceId: workspaceId,
        policyKey: "ci-bounded",
        purpose: "TEST",
        executable: "node",
        arguments: ["-e", countScript],
        timeoutMs: 5_000,
        maxOutputBytes: 256,
        environment: {},
        actor,
      }),
    "WRITE command preparation must fail when AUTOMATED_WRITE is disabled",
  );
  await setAutomatedWrite(true, "CI execute bounded workspace commands");

  await expectRejected(
    () =>
      commandStore.prepareWorkspaceCommand({
        repositoryWorkspaceId: workspaceId,
        policyKey: "ci-bounded",
        purpose: "TEST",
        executable: "sh",
        arguments: ["-c", "echo unsafe"],
        timeoutMs: 5_000,
        maxOutputBytes: 256,
        environment: {},
        actor,
      }),
    "unapproved executables must fail closed",
  );
  await expectRejected(
    () =>
      commandStore.prepareWorkspaceCommand({
        repositoryWorkspaceId: workspaceId,
        policyKey: "ci-bounded",
        purpose: "TEST",
        executable: "node",
        arguments: ["-e", environmentScript],
        timeoutMs: 5_000,
        maxOutputBytes: 256,
        environment: { OPENAI_API_KEY: "must-not-delegate" },
        actor,
      }),
    "undelegated provider credentials must fail closed",
  );

  const countPrepared = await commandStore.prepareWorkspaceCommand({
    repositoryWorkspaceId: workspaceId,
    policyKey: "ci-bounded",
    purpose: "TEST",
    executable: "node",
    arguments: ["-e", countScript],
    timeoutMs: 5_000,
    maxOutputBytes: 256,
    environment: {},
    actor,
  });
  const countRunId = String(countPrepared.run.id);
  const countRetry = await commandStore.prepareWorkspaceCommand({
    repositoryWorkspaceId: workspaceId,
    policyKey: "ci-bounded",
    purpose: "TEST",
    executable: "node",
    arguments: ["-e", countScript],
    timeoutMs: 5_000,
    maxOutputBytes: 256,
    environment: {},
    actor,
  });
  assert.equal(String(countRetry.run.id), countRunId);
  await Promise.all([
    commandService.run({ workspaceCommandRunId: countRunId, actor }),
    commandService.run({ workspaceCommandRunId: countRunId, actor }),
  ]);
  const countFinal = await commandStore.getWorkspaceCommandRun(countRunId);
  assert.equal(countFinal.status, "SUCCEEDED");
  assert.equal(await readFile(path.join(workspacePath, "command-count.txt"), "utf8"), "x");
  const countEvidenceRows = await pool.query(
    "SELECT count(*)::int AS count FROM workspace_command_evidence WHERE workspace_command_run_id = $1",
    [countRunId],
  );
  assert.equal(countEvidenceRows.rows[0].count, 1);

  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "ci-secret-must-not-leak";
  try {
    const environmentPrepared = await commandStore.prepareWorkspaceCommand({
      repositoryWorkspaceId: workspaceId,
      policyKey: "ci-bounded",
      purpose: "INSPECT",
      executable: "node",
      arguments: ["-e", environmentScript],
      timeoutMs: 5_000,
      maxOutputBytes: 256,
      environment: { KARSIFT_COMMAND_TEST: "visible" },
      actor,
    });
    const environmentRunId = String(environmentPrepared.run.id);
    await commandService.run({ workspaceCommandRunId: environmentRunId, actor });
    const environmentFinal = await commandStore.getWorkspaceCommandRun(environmentRunId);
    assert.equal(environmentFinal.status, "SUCCEEDED");
  } finally {
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  }

  const outputPrepared = await commandStore.prepareWorkspaceCommand({
    repositoryWorkspaceId: workspaceId,
    policyKey: "ci-bounded",
    purpose: "TEST",
    executable: "node",
    arguments: ["-e", outputScript],
    timeoutMs: 5_000,
    maxOutputBytes: 128,
    environment: {},
    actor,
  });
  const outputRunId = String(outputPrepared.run.id);
  await commandService.run({ workspaceCommandRunId: outputRunId, actor });
  const outputFinal = await commandStore.getWorkspaceCommandRun(outputRunId);
  assert.equal(outputFinal.status, "SUCCEEDED");
  assert.equal(outputFinal.evidence.stdout_bytes, "10000");
  assert.equal(outputFinal.evidence.stdout_truncated, true);

  const timeoutPrepared = await commandStore.prepareWorkspaceCommand({
    repositoryWorkspaceId: workspaceId,
    policyKey: "ci-bounded",
    purpose: "TEST",
    executable: "node",
    arguments: ["-e", timeoutScript],
    timeoutMs: 100,
    maxOutputBytes: 128,
    environment: {},
    actor,
  });
  const timeoutRunId = String(timeoutPrepared.run.id);
  await commandService.run({ workspaceCommandRunId: timeoutRunId, actor });
  const timeoutFinal = await commandStore.getWorkspaceCommandRun(timeoutRunId);
  assert.equal(timeoutFinal.status, "TIMED_OUT");
  assert.equal(timeoutFinal.evidence.timed_out, true);

  const capabilityPrepared = await commandStore.prepareWorkspaceCommand({
    repositoryWorkspaceId: workspaceId,
    policyKey: "ci-bounded",
    purpose: "TEST",
    executable: "node",
    arguments: ["-e", successScript],
    timeoutMs: 5_000,
    maxOutputBytes: 128,
    environment: {},
    actor,
  });
  const capabilityRunId = String(capabilityPrepared.run.id);
  await setAutomatedWrite(false, "CI prove command start-time write recheck");
  await expectRejected(
    () => commandService.run({ workspaceCommandRunId: capabilityRunId, actor }),
    "WRITE command start must re-check AUTOMATED_WRITE",
  );
  const capabilityBlocked = await commandStore.getWorkspaceCommandRun(capabilityRunId);
  assert.equal(capabilityBlocked.status, "PREPARED");
  await setAutomatedWrite(true, "CI resume command verification");
  await commandService.run({ workspaceCommandRunId: capabilityRunId, actor });
  const capabilityFinal = await commandStore.getWorkspaceCommandRun(capabilityRunId);
  assert.equal(capabilityFinal.status, "SUCCEEDED");

  const sixthPrepared = await commandStore.prepareWorkspaceCommand({
    repositoryWorkspaceId: workspaceId,
    policyKey: "ci-bounded",
    purpose: "INSPECT",
    executable: "node",
    arguments: ["--version"],
    timeoutMs: 5_000,
    maxOutputBytes: 128,
    environment: {},
    actor,
  });
  await commandService.run({
    workspaceCommandRunId: String(sixthPrepared.run.id),
    actor,
  });
  await expectRejected(
    () =>
      commandStore.prepareWorkspaceCommand({
        repositoryWorkspaceId: workspaceId,
        policyKey: "ci-bounded",
        purpose: "INSPECT",
        executable: "node",
        arguments: ["-p", "1+1"],
        timeoutMs: 5_000,
        maxOutputBytes: 128,
        environment: {},
        actor,
      }),
    "workspace command budget must fail closed after six unique plans",
  );

  await expectRejected(
    () =>
      pool.query(
        "UPDATE workspace_command_policies SET enabled = false WHERE id = $1",
        [policy.id],
      ),
    "workspace command policy snapshots must be immutable",
  );
  await expectRejected(
    () =>
      pool.query(
        "UPDATE workspace_command_plans SET timeout_ms = timeout_ms + 1 WHERE id = $1",
        [countPrepared.plan.id],
      ),
    "workspace command plans must be immutable",
  );
  await expectRejected(
    () =>
      pool.query(
        "UPDATE workspace_command_evidence SET stdout_truncated = false WHERE workspace_command_run_id = $1",
        [outputRunId],
      ),
    "workspace command terminal evidence must be immutable",
  );

  const finalized = await workspaceService.finalize({
    repositoryWorkspaceId: workspaceId,
    actor,
  });
  assert.equal(finalized.workspace.status, "FINALIZED");
  assert.equal(finalized.evidence.scope_valid, true);
  assert.deepEqual(finalized.evidence.changed_paths, ["command-count.txt"]);
  assert.equal(await pathExists(workspacePath), false);
  assert.equal(await pathExists(path.join(sourceRepository, "command-count.txt")), false);

  await coreStore.releaseExecutionLease({
    executionAttemptId: String(preparedBuilder.claim.executionAttempt.id),
    leaseToken: String(preparedBuilder.claim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });
  await setAutomatedWrite(false, "CI workspace command verification complete");
  await pool.query(
    `UPDATE capability_switches
        SET enabled = false,
            reason = 'CI workspace command verification complete',
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

  console.log("Bounded workspace command execution invariants verified successfully.");
} finally {
  await pool.end();
  await rm(tempRoot, { recursive: true, force: true });
}
