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
const systemActor = { type: "SYSTEM", id: "ci-authorization-system" };
const founderActor = { type: "FOUNDER", id: "ci-founder" };
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

function governance(
  riskLevel,
  {
    founderApprovalRequired = false,
    ehrRequired = false,
    strengthenedGatesSatisfied = false,
    protectedTechnicalWork = false,
  } = {},
) {
  return {
    riskLevel,
    founderApprovalRequired,
    ehrRequired,
    strengthenedGatesSatisfied,
    protectedTechnicalWork,
  };
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

try {
  const project = await store.createProject(
    {
      slug: `ci-auth-${suffix}`.slice(0, 63),
      name: "CI Authorization Project",
      repositoryFullName: `KARSIFT/ci-auth-${suffix}`,
      defaultBranch: "main",
      integrationBranch: "develop",
    },
    systemActor,
  );
  const projectId = String(project.id);

  const r4 = await store.createChangeContract({
    projectId,
    stableId: `CI-R4-${suffix}`,
    content: {
      objective: "verify founder-only R4 authority",
      governance: governance("R4"),
    },
    actor: systemActor,
  });
  const r4ContractId = String(r4.contract.id);
  const r4VersionId = String(r4.version.id);

  const deniedR4 = await store.recordChangeContractAuthorization({
    changeContractId: r4ContractId,
    action: "AUTHORIZE",
    rationale: "system must not authorize R4",
    actor: systemActor,
  });
  assert.equal(deniedR4.authorized, false);
  assert.equal(deniedR4.decision.decision, "DENIED");
  assert.equal(deniedR4.decision.reason_code, "FOUNDER_AUTHORITY_REQUIRED");

  const founderR4 = await store.recordChangeContractAuthorization({
    changeContractId: r4ContractId,
    action: "AUTHORIZE",
    rationale: "founder authorizes exact R4 version",
    actor: founderActor,
  });
  assert.equal(founderR4.authorized, true);
  assert.equal(founderR4.decision.decision, "AUTHORIZED");

  const deniedAfterAuthorization = await store.recordChangeContractAuthorization({
    changeContractId: r4ContractId,
    action: "AUTHORIZE",
    rationale: "denied retry must not revoke existing authority",
    actor: systemActor,
  });
  assert.equal(deniedAfterAuthorization.authorized, false);

  const effectiveAfterDenial = await pool.query(
    "SELECT has_effective_change_contract_authorization($1, $2) AS authorized",
    [r4VersionId, r4.version.content_hash],
  );
  assert.equal(
    effectiveAfterDenial.rows[0].authorized,
    true,
    "a DENIED attempt must not revoke a prior explicit authorization",
  );

  await expectRejected(
    () =>
      pool.query(
        "UPDATE change_contract_authorization_decisions SET rationale = 'mutated' WHERE id = $1",
        [founderR4.decision.id],
      ),
    "authorization evidence must be append-only",
  );

  const r3 = await store.createChangeContract({
    projectId,
    stableId: `CI-R3-${suffix}`,
    content: {
      objective: "verify strengthened R3 gates",
      governance: governance("R3", {
        strengthenedGatesSatisfied: false,
        protectedTechnicalWork: true,
      }),
    },
    actor: systemActor,
  });
  const r3ContractId = String(r3.contract.id);

  const deniedR3 = await store.recordChangeContractAuthorization({
    changeContractId: r3ContractId,
    action: "AUTHORIZE",
    rationale: "R3 gates are not yet satisfied",
    actor: systemActor,
  });
  assert.equal(deniedR3.authorized, false);
  assert.equal(
    deniedR3.decision.reason_code,
    "R3_STRENGTHENED_GATES_REQUIRED",
  );

  const r3VersionTwo = await store.appendChangeContractVersion({
    contractId: r3ContractId,
    content: {
      objective: "verify strengthened R3 gates",
      governance: governance("R3", {
        strengthenedGatesSatisfied: true,
        protectedTechnicalWork: true,
      }),
    },
    actor: systemActor,
  });

  const authorizedR3 = await store.recordChangeContractAuthorization({
    changeContractId: r3ContractId,
    action: "AUTHORIZE",
    rationale: "strengthened gates are satisfied",
    actor: systemActor,
  });
  assert.equal(authorizedR3.authorized, true);
  assert.equal(authorizedR3.decision.risk_level, "R3");
  assert.equal(
    authorizedR3.decision.change_contract_version_id,
    String(r3VersionTwo.id),
  );

  const ehrContract = await store.createChangeContract({
    projectId,
    stableId: `CI-EHR-${suffix}`,
    content: {
      objective: "verify exceptional handling authority",
      governance: governance("R2", { ehrRequired: true }),
    },
    actor: systemActor,
  });
  const deniedEhr = await store.recordChangeContractAuthorization({
    changeContractId: String(ehrContract.contract.id),
    action: "AUTHORIZE",
    rationale: "EHR requires founder authority",
    actor: systemActor,
  });
  assert.equal(deniedEhr.authorized, false);
  assert.equal(deniedEhr.decision.required_authority, "FOUNDER");

  const forged = await store.createChangeContract({
    projectId,
    stableId: `CI-FORGED-${suffix}`,
    content: {
      objective: "prove mutable status cannot create authority",
      governance: governance("R2"),
    },
    actor: systemActor,
  });
  const forgedContractId = String(forged.contract.id);
  const forgedVersionId = String(forged.version.id);

  await pool.query(
    "UPDATE change_contracts SET status = 'AUTHORIZED' WHERE id = $1",
    [forgedContractId],
  );

  const forgedTask = await store.createTask({
    projectId,
    changeContractVersionId: forgedVersionId,
    title: "Forged authority task",
    description: "Must be blocked without append-only authorization evidence",
    priority: "P0",
    actor: systemActor,
  });
  const forgedWork = await store.createWorkQueueItem({
    projectId,
    taskId: String(forgedTask.id),
    priority: "P0",
    executionPolicy: "IMMEDIATE",
    scheduledFor: null,
    idempotencyKey: `auth-forged:${projectId}:${forgedTask.id}`,
    actor: systemActor,
  });

  const forgedValidation = await store.validateWorkQueueItem({
    workQueueItemId: String(forgedWork.id),
    actor: systemActor,
  });
  assert.equal(forgedValidation.validation.outcome, "BLOCKED");
  assert.equal(
    forgedValidation.validation.reason_code,
    "CONTRACT_NOT_AUTHORIZED",
  );

  await pool.query(
    `UPDATE work_queue_items
        SET status = 'ELIGIBLE', waiting_reason = 'NONE'
      WHERE id = $1`,
    [forgedWork.id],
  );

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
         ) VALUES ($1, $2, 1, $3, 'forged-worker', now() + interval '5 minutes')`,
        [
          forgedWork.id,
          projectId,
          `auth-forged:${projectId}:${forgedTask.id}`,
        ],
      ),
    "database execution-attempt gate must reject forged mutable authorization status",
  );

  const revocation = await store.recordChangeContractAuthorization({
    changeContractId: r4ContractId,
    action: "REVOKE",
    rationale: "explicitly revoke exact R4 authority",
    actor: systemActor,
  });
  assert.equal(revocation.decision.decision, "REVOKED");

  const effectiveAfterRevocation = await pool.query(
    "SELECT has_effective_change_contract_authorization($1, $2) AS authorized",
    [r4VersionId, r4.version.content_hash],
  );
  assert.equal(effectiveAfterRevocation.rows[0].authorized, false);

  console.log("Change Contract authorization policy invariants verified successfully.");
} finally {
  await pool.end();
}
