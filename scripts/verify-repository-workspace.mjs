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

import { LocalGitWorkspaceAdapter } from "../dist/repository/local-git-workspace-adapter.js";
import { RepositoryWorkspaceAdapterRegistry } from "../dist/repository/repository-workspace-adapter.js";
import { RepositoryWorkspaceService } from "../dist/services/repository-workspace-service.js";
import { ExtendedPostgresControlPlaneStore } from "../dist/store/extended-postgres-store.js";
import { PostgresRepositoryWorkspaceStore } from "../dist/store/repository-workspace-store.js";

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
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "karsift-workspace-ci-"));
const sourceRoot = path.join(tempRoot, "sources");
const workspaceRoot = path.join(tempRoot, "workspaces");
const sourceRepositoryPath = "fixture-repo";
const sourceRepository = path.join(sourceRoot, sourceRepositoryPath);
const adapter = new LocalGitWorkspaceAdapter({ sourceRoot, workspaceRoot });
const workspaceService = new RepositoryWorkspaceService(
  workspaceStore,
  new RepositoryWorkspaceAdapterRegistry([adapter]),
  { sourceRoot, workspaceRoot },
);
const actor = { type: "SYSTEM", id: "ci-repository-workspace-verifier" };
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

try {
  await mkdir(path.join(sourceRepository, "src"), { recursive: true });
  await writeFile(path.join(sourceRepository, "src", "allowed.txt"), "base allowed\n");
  await writeFile(path.join(sourceRepository, "src", "outside.txt"), "base outside\n");
  await writeFile(path.join(sourceRepository, "README.md"), "fixture repository\n");
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
      slug: `ci-workspace-${suffix}`.slice(0, 63),
      name: "CI Repository Workspace Project",
      repositoryFullName: `KARSIFT/ci-workspace-${suffix}`,
      defaultBranch: "main",
      integrationBranch: "develop",
    },
    actor,
  );
  const projectId = String(project.id);

  const contractBundle = await coreStore.createChangeContract({
    projectId,
    stableId: `CI-WORKSPACE-${suffix}`,
    content: {
      objective: "verify isolated repository workspaces",
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
    rationale: "CI repository workspace authorization",
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
    providerKeys: ["ci-workspace-builder"],
    enabled: true,
    actor,
  });
  await coreStore.recordProviderCapacityObservation({
    projectId,
    providerKey: "ci-workspace-builder",
    capability: "CODE_BUILDER",
    status: "HEALTHY",
    ttlSeconds: 3600,
    quotaResetAt: null,
    details: { source: "ci-repository-workspace-verifier" },
    actor,
  });
  await pool.query(
    `INSERT INTO capability_switches(
       scope_type, project_id, capability, enabled, reason, updated_by
     ) VALUES (
       'PROJECT', $1, 'AI_DISPATCH', true,
       'CI-only repository workspace verification', 'ci'
     )`,
    [projectId],
  );

  async function setAutomatedWrite(enabled, reason) {
    await pool.query(
      `INSERT INTO capability_switches(
         scope_type, project_id, capability, enabled, reason, updated_by
       ) VALUES ('PROJECT', $1, 'AUTOMATED_WRITE', $2, $3, 'ci')
       ON CONFLICT (
         scope_type,
         COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
         capability
       ) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         reason = EXCLUDED.reason,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [projectId, enabled, reason],
    );
  }

  async function createPreparedBuilder(name, relevantPaths, priority = "P1") {
    const task = await coreStore.createTask({
      projectId,
      changeContractVersionId: versionId,
      title: name,
      description: `Repository workspace verification: ${name}`,
      priority,
      actor,
    });
    const work = await coreStore.createWorkQueueItem({
      projectId,
      taskId: String(task.id),
      priority,
      executionPolicy: "IMMEDIATE",
      scheduledFor: null,
      idempotencyKey: `workspace:${projectId}:${task.id}`,
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
      leaseOwner: `workspace-${name}`,
      leaseSeconds: 900,
      actor,
    });
    assert.notEqual(claim, null);
    assert.equal(String(claim.workItem.id), workQueueItemId);
    const pack = await coreStore.createTaskContextPack({
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
    return { task, workQueueItemId, claim, pack, builder };
  }

  const allowed = await createPreparedBuilder(
    "Allowed workspace change",
    ["src/allowed.txt"],
    "P0",
  );
  const allowedInvocationId = String(allowed.builder.invocation.id);

  await expectRejected(
    () =>
      workspaceStore.prepareRepositoryWorkspace({
        builderInvocationId: allowedInvocationId,
        mode: "WRITE",
        actor,
      }),
    "WRITE workspace preparation must fail while AUTOMATED_WRITE is disabled",
  );

  await setAutomatedWrite(true, "CI-only allowed workspace mutation");
  const allowedPrepared = await workspaceStore.prepareRepositoryWorkspace({
    builderInvocationId: allowedInvocationId,
    mode: "WRITE",
    actor,
  });
  assert.equal(allowedPrepared.plan.mode, "WRITE");
  assert.deepEqual(allowedPrepared.plan.relevant_paths, ["src/allowed.txt"]);
  assert.match(String(allowedPrepared.plan.plan_hash), /^[a-f0-9]{64}$/);

  const allowedWorkspaceId = String(allowedPrepared.workspace.id);
  const allowedMaterialized = await workspaceService.materialize({
    repositoryWorkspaceId: allowedWorkspaceId,
    sourceRepositoryPath,
    actor,
  });
  assert.equal(allowedMaterialized.workspace.status, "MATERIALIZED");
  assert.equal(allowedMaterialized.workspace.materialized_head_sha, baseCommitSha);
  const allowedWorkspace = await workspaceStore.getRepositoryWorkspace(allowedWorkspaceId);
  const allowedWorkspacePath = String(allowedWorkspace.workspace_path);
  assert.equal(await pathExists(allowedWorkspacePath), true);

  await writeFile(
    path.join(allowedWorkspacePath, "src", "allowed.txt"),
    "changed within scope\n",
  );
  const allowedFinalized = await workspaceService.finalize({
    repositoryWorkspaceId: allowedWorkspaceId,
    actor,
  });
  assert.equal(allowedFinalized.workspace.status, "FINALIZED");
  assert.equal(allowedFinalized.evidence.scope_valid, true);
  assert.deepEqual(allowedFinalized.evidence.changed_paths, ["src/allowed.txt"]);
  assert.deepEqual(allowedFinalized.evidence.violations, []);
  assert.match(String(allowedFinalized.evidence.evidence_hash), /^[a-f0-9]{64}$/);
  assert.equal(await pathExists(allowedWorkspacePath), false);
  assert.equal(
    await readFile(path.join(sourceRepository, "src", "allowed.txt"), "utf8"),
    "base allowed\n",
    "materialized workspace changes must not mutate the source repository",
  );

  await expectRejected(
    () =>
      pool.query(
        "UPDATE repository_workspace_plans SET mode = 'READ_ONLY' WHERE id = $1",
        [allowedPrepared.plan.id],
      ),
    "repository workspace plans must be immutable",
  );
  await expectRejected(
    () =>
      pool.query(
        "UPDATE repository_workspace_evidence SET scope_valid = false WHERE id = $1",
        [allowedFinalized.evidence.id],
      ),
    "repository workspace evidence must be immutable",
  );

  await coreStore.releaseExecutionLease({
    executionAttemptId: String(allowed.claim.executionAttempt.id),
    leaseToken: String(allowed.claim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });

  const violation = await createPreparedBuilder(
    "Out of scope workspace change",
    ["src/allowed.txt"],
    "P1",
  );
  const violationPrepared = await workspaceStore.prepareRepositoryWorkspace({
    builderInvocationId: String(violation.builder.invocation.id),
    mode: "WRITE",
    actor,
  });
  const violationWorkspaceId = String(violationPrepared.workspace.id);
  await workspaceService.materialize({
    repositoryWorkspaceId: violationWorkspaceId,
    sourceRepositoryPath,
    actor,
  });
  const violationWorkspace = await workspaceStore.getRepositoryWorkspace(
    violationWorkspaceId,
  );
  const violationWorkspacePath = String(violationWorkspace.workspace_path);
  await writeFile(
    path.join(violationWorkspacePath, "src", "outside.txt"),
    "changed outside scope\n",
  );
  const violationFinalized = await workspaceService.finalize({
    repositoryWorkspaceId: violationWorkspaceId,
    actor,
  });
  assert.equal(violationFinalized.workspace.status, "SCOPE_VIOLATION");
  assert.equal(violationFinalized.evidence.scope_valid, false);
  assert.deepEqual(violationFinalized.evidence.violations, ["src/outside.txt"]);
  assert.equal(await pathExists(violationWorkspacePath), false);

  await coreStore.releaseExecutionLease({
    executionAttemptId: String(violation.claim.executionAttempt.id),
    leaseToken: String(violation.claim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });

  const capabilityRecheck = await createPreparedBuilder(
    "Finalization capability recheck",
    ["src/allowed.txt"],
    "P1",
  );
  const capabilityPrepared = await workspaceStore.prepareRepositoryWorkspace({
    builderInvocationId: String(capabilityRecheck.builder.invocation.id),
    mode: "WRITE",
    actor,
  });
  const capabilityWorkspaceId = String(capabilityPrepared.workspace.id);
  await workspaceService.materialize({
    repositoryWorkspaceId: capabilityWorkspaceId,
    sourceRepositoryPath,
    actor,
  });
  const capabilityWorkspace = await workspaceStore.getRepositoryWorkspace(
    capabilityWorkspaceId,
  );
  const capabilityWorkspacePath = String(capabilityWorkspace.workspace_path);
  await writeFile(
    path.join(capabilityWorkspacePath, "src", "allowed.txt"),
    "write capability recheck\n",
  );

  await setAutomatedWrite(false, "CI prove finalization capability recheck");
  await expectRejected(
    () =>
      workspaceService.finalize({
        repositoryWorkspaceId: capabilityWorkspaceId,
        actor,
      }),
    "WRITE workspace finalization must re-check AUTOMATED_WRITE capability",
  );
  assert.equal(await pathExists(capabilityWorkspacePath), true);

  await setAutomatedWrite(true, "CI continue workspace verification");
  const capabilityFinalized = await workspaceService.finalize({
    repositoryWorkspaceId: capabilityWorkspaceId,
    actor,
  });
  assert.equal(capabilityFinalized.workspace.status, "FINALIZED");
  assert.equal(capabilityFinalized.evidence.scope_valid, true);

  await coreStore.releaseExecutionLease({
    executionAttemptId: String(capabilityRecheck.claim.executionAttempt.id),
    leaseToken: String(capabilityRecheck.claim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });

  await setAutomatedWrite(false, "CI prove read-only workspace independence");
  const readOnly = await createPreparedBuilder(
    "Read-only workspace",
    ["src/allowed.txt"],
    "P2",
  );
  const readOnlyPrepared = await workspaceStore.prepareRepositoryWorkspace({
    builderInvocationId: String(readOnly.builder.invocation.id),
    mode: "READ_ONLY",
    actor,
  });
  const readOnlyWorkspaceId = String(readOnlyPrepared.workspace.id);
  await workspaceService.materialize({
    repositoryWorkspaceId: readOnlyWorkspaceId,
    sourceRepositoryPath,
    actor,
  });
  const readOnlyFinalized = await workspaceService.finalize({
    repositoryWorkspaceId: readOnlyWorkspaceId,
    actor,
  });
  assert.equal(readOnlyFinalized.workspace.status, "FINALIZED");
  assert.equal(readOnlyFinalized.evidence.scope_valid, true);
  assert.deepEqual(readOnlyFinalized.evidence.changed_paths, []);

  await coreStore.releaseExecutionLease({
    executionAttemptId: String(readOnly.claim.executionAttempt.id),
    leaseToken: String(readOnly.claim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });

  const invalidSource = await createPreparedBuilder(
    "Invalid local source path",
    ["src/allowed.txt"],
    "P2",
  );
  const invalidSourcePrepared = await workspaceStore.prepareRepositoryWorkspace({
    builderInvocationId: String(invalidSource.builder.invocation.id),
    mode: "READ_ONLY",
    actor,
  });
  await expectRejected(
    () =>
      workspaceService.materialize({
        repositoryWorkspaceId: String(invalidSourcePrepared.workspace.id),
        sourceRepositoryPath: "../escape",
        actor,
      }),
    "local repository source paths must not escape the configured source root",
  );
  const failedWorkspace = await workspaceStore.getRepositoryWorkspace(
    String(invalidSourcePrepared.workspace.id),
  );
  assert.equal(failedWorkspace.status, "FAILED");

  await coreStore.releaseExecutionLease({
    executionAttemptId: String(invalidSource.claim.executionAttempt.id),
    leaseToken: String(invalidSource.claim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });

  const sourceHead = (
    await run("git", ["-C", sourceRepository, "rev-parse", "HEAD"])
  ).stdout.trim();
  assert.equal(sourceHead, baseCommitSha);
  const sourceKarsiftBranches = (
    await run("git", ["-C", sourceRepository, "branch", "--list", "karsift/*"])
  ).stdout.trim();
  assert.equal(sourceKarsiftBranches, "");

  const status = await workspaceStore.getProjectRepositoryWorkspaceStatus(projectId);
  assert.equal(status.recentRepositoryWorkspaces.length >= 5, true);

  await setAutomatedWrite(false, "CI verification complete");
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

  console.log("Repository workspace isolation and scope invariants verified successfully.");
} finally {
  await pool.end();
  await rm(tempRoot, { recursive: true, force: true });
}
