import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";

import { BuilderProposalAdapterRegistry } from "../dist/agents/builder-proposal-adapter.js";
import { FixtureBuilderProposalAdapter } from "../dist/agents/fixture-builder-proposal-adapter.js";
import { LocalGitWorkspaceAdapter } from "../dist/repository/local-git-workspace-adapter.js";
import { RepositoryWorkspaceAdapterRegistry } from "../dist/repository/repository-workspace-adapter.js";
import { WorkspaceReadContextCapturer } from "../dist/repository/workspace-read-context-capturer.js";
import { BuilderProposalService } from "../dist/services/builder-proposal-service.js";
import { RepositoryWorkspaceService } from "../dist/services/repository-workspace-service.js";
import { WorkspaceReadContextService } from "../dist/services/workspace-read-context-service.js";
import { PostgresBuilderProposalStore } from "../dist/store/builder-proposal-store.js";
import { ExtendedPostgresControlPlaneStore } from "../dist/store/extended-postgres-store.js";
import { PostgresRepositoryWorkspaceStore } from "../dist/store/repository-workspace-store.js";
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
const readContextStore = new PostgresWorkspaceReadContextStore(pool);
const proposalStore = new PostgresBuilderProposalStore(pool);
const proposalService = new BuilderProposalService(
  proposalStore,
  coreStore,
  new BuilderProposalAdapterRegistry([new FixtureBuilderProposalAdapter()]),
);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "karsift-proposal-ci-"));
const sourceRoot = path.join(tempRoot, "sources");
const workspaceRoot = path.join(tempRoot, "workspaces");
const sourceRepositoryPath = "fixture-repo";
const sourceRepository = path.join(sourceRoot, sourceRepositoryPath);
const workspaceService = new RepositoryWorkspaceService(
  workspaceStore,
  new RepositoryWorkspaceAdapterRegistry([
    new LocalGitWorkspaceAdapter({ sourceRoot, workspaceRoot }),
  ]),
  { sourceRoot, workspaceRoot },
);
const readContextService = new WorkspaceReadContextService(
  readContextStore,
  new WorkspaceReadContextCapturer(workspaceRoot),
);
const actor = { type: "SYSTEM", id: "ci-builder-proposal-verifier" };
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

try {
  await mkdir(path.join(sourceRepository, "src"), { recursive: true });
  await writeFile(path.join(sourceRepository, "src", "index.ts"), "export const value = 1;\n");
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
      slug: `ci-proposal-${suffix}`.slice(0, 63),
      name: "CI Builder Proposal Project",
      repositoryFullName: `KARSIFT/ci-proposal-${suffix}`,
      defaultBranch: "main",
      integrationBranch: "develop",
    },
    actor,
  );
  const projectId = String(project.id);
  const contractBundle = await coreStore.createChangeContract({
    projectId,
    stableId: `CI-PROPOSAL-${suffix}`,
    content: {
      objective: "verify structured builder proposals",
      deliverables: ["produce one inert structured proposal"],
      acceptanceCriteria: ["proposal remains non-executing"],
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
        rationale: "CI builder proposal authorization",
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
    providerKeys: ["ci-proposal-provider"],
    enabled: true,
    actor,
  });
  await coreStore.recordProviderCapacityObservation({
    projectId,
    providerKey: "ci-proposal-provider",
    capability: "CODE_BUILDER",
    status: "HEALTHY",
    ttlSeconds: 3600,
    quotaResetAt: null,
    details: { source: "ci-builder-proposal-verifier" },
    actor,
  });
  await pool.query(
    `INSERT INTO capability_switches(
       scope_type, project_id, capability, enabled, reason, updated_by
     ) VALUES ('PROJECT', $1, 'AI_DISPATCH', true, 'CI-only proposal verification', 'ci')`,
    [projectId],
  );

  const task = await coreStore.createTask({
    projectId,
    changeContractVersionId: versionId,
    title: "Structured builder proposal",
    description: "Verify proposal-only model authority",
    priority: "P0",
    actor,
  });
  const work = await coreStore.createWorkQueueItem({
    projectId,
    taskId: String(task.id),
    priority: "P0",
    executionPolicy: "IMMEDIATE",
    scheduledFor: null,
    idempotencyKey: `builder-proposal:${projectId}:${task.id}`,
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
    leaseOwner: `builder-proposal-${suffix}`,
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
  const builderInvocationId = String(builder.invocation.id);

  const preparedWorkspace = await workspaceStore.prepareRepositoryWorkspace({
    builderInvocationId,
    mode: "READ_ONLY",
    actor,
  });
  const workspaceId = String(preparedWorkspace.workspace.id);
  await workspaceService.materialize({
    repositoryWorkspaceId: workspaceId,
    sourceRepositoryPath,
    actor,
  });
  const preparedReadContext = await readContextStore.prepareWorkspaceReadContext({
    repositoryWorkspaceId: workspaceId,
    requestedPaths: ["src"],
    actor,
  });
  const readContextRunId = String(preparedReadContext.run.id);
  await readContextService.capture({ workspaceReadContextRunId: readContextRunId, actor });

  const preparedProposal = await proposalStore.prepareBuilderProposal({
    builderInvocationId,
    workspaceReadContextRunId: readContextRunId,
    actor,
  });
  const proposalRunId = String(preparedProposal.run.id);
  const duplicateProposal = await proposalStore.prepareBuilderProposal({
    builderInvocationId,
    workspaceReadContextRunId: readContextRunId,
    actor,
  });
  assert.equal(String(duplicateProposal.run.id), proposalRunId);

  await expectRejected(
    () =>
      proposalStore.claimBuilderProposalRun({
        builderProposalRunId: proposalRunId,
        builderDispatchClaimId: "00000000-0000-0000-0000-000000000001",
        builderDispatchRevalidationId: "00000000-0000-0000-0000-000000000002",
        actor,
      }),
    "proposal generation must reject missing dispatch evidence",
  );

  await Promise.all([
    proposalService.generate({
      builderProposalRunId: proposalRunId,
      claimOwner: `proposal-worker-a-${suffix}`,
      claimLeaseSeconds: 300,
      actor,
    }),
    proposalService.generate({
      builderProposalRunId: proposalRunId,
      claimOwner: `proposal-worker-b-${suffix}`,
      claimLeaseSeconds: 300,
      actor,
    }),
  ]);

  const generated = await proposalStore.getBuilderProposalRun(proposalRunId);
  assert.equal(generated.status, "GENERATED");
  assert.equal(generated.evidence.outcome, "GENERATED");
  assert.equal(generated.evidence.proposal_action, "COMPLETE");
  assert.equal(generated.evidence.external_provider_called, false);
  assert.equal(generated.evidence.provider_request_id, null);
  assert.match(generated.evidence.proposal_hash, /^[a-f0-9]{64}$/);
  assert.match(generated.evidence.result_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(generated.evidence.proposal_content.requestedPaths, []);
  assert.deepEqual(generated.evidence.proposal_content.commands, []);
  assert.deepEqual(generated.evidence.proposal_content.mutations, []);

  const evidenceCount = await pool.query(
    "SELECT count(*)::int AS count FROM builder_proposal_evidence WHERE builder_proposal_run_id = $1",
    [proposalRunId],
  );
  assert.equal(evidenceCount.rows[0].count, 1);
  const activeClaims = await pool.query(
    `SELECT count(*)::int AS count
       FROM builder_dispatch_claims
      WHERE builder_invocation_id = $1
        AND status = 'ACTIVE'`,
    [builderInvocationId],
  );
  assert.equal(activeClaims.rows[0].count, 0);

  await expectRejected(
    () =>
      pool.query(
        "UPDATE builder_proposal_requests SET provider_key = 'mutated' WHERE id = $1",
        [preparedProposal.request.id],
      ),
    "builder proposal requests must be immutable",
  );
  await expectRejected(
    () =>
      pool.query(
        "UPDATE builder_proposal_evidence SET proposal_action = 'BLOCKED' WHERE builder_proposal_run_id = $1",
        [proposalRunId],
      ),
    "builder proposal evidence must be immutable",
  );
  await expectRejected(
    () =>
      pool.query(
        `INSERT INTO builder_proposal_evidence(
           project_id, builder_proposal_run_id, outcome, proposal_action,
           proposal_content, proposal_hash, external_provider_called,
           provider_request_id, usage, error_code, result_hash, created_by
         ) VALUES (
           $1, $2, 'GENERATED', 'COMPLETE', '{}'::jsonb, repeat('a', 64),
           true, 'forbidden', '{}'::jsonb, NULL, repeat('b', 64), 'ci'
         )`,
        [projectId, proposalRunId],
      ),
    "ADP-017 evidence schema must reject external-provider calls",
  );

  await workspaceService.abandon({ repositoryWorkspaceId: workspaceId, actor });
  await coreStore.releaseExecutionLease({
    executionAttemptId: String(claim.executionAttempt.id),
    leaseToken: String(claim.executionAttempt.lease_token),
    waitingReason: "NONE",
    actor,
  });
  await pool.query(
    `UPDATE capability_switches
        SET enabled = false,
            reason = 'CI builder proposal verification complete',
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

  console.log("Structured builder proposal invariants verified successfully.");
} finally {
  await pool.end();
  await rm(tempRoot, { recursive: true, force: true });
}
