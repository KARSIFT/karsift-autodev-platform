import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("foundation migration encodes append-only and project-isolation constraints", async () => {
  const sql = await readFile(
    path.resolve(process.cwd(), "migrations/0001_control_plane_foundation.sql"),
    "utf8",
  );

  assert.match(sql, /change_contract_versions_immutable/);
  assert.match(sql, /audit_events_immutable/);
  assert.match(
    sql,
    /FOREIGN KEY\(change_contract_version_id, project_id\)/,
  );
  assert.match(sql, /FOREIGN KEY\(task_id, project_id\)/);
  assert.match(sql, /'AI_DISPATCH', false/);
  assert.doesNotMatch(sql, /^\s*BEGIN;/m);
  assert.doesNotMatch(sql, /^\s*COMMIT;/m);
});

test("work queue migration and store encode duplicate-safe lease constraints", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0002_work_queue_execution_leases.sql"),
    "utf8",
  );
  const store = await readFile(
    path.resolve(process.cwd(), "src/store/work-queue-store.ts"),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS work_queue_items/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS execution_attempts/);
  assert.match(migration, /execution_attempt_one_active_idx/);
  assert.match(migration, /UNIQUE\(project_id, idempotency_key\)/);
  assert.match(migration, /FOREIGN KEY\(work_queue_item_id, project_id\)/);
  assert.match(store, /FOR UPDATE(?: OF w)? SKIP LOCKED/);
  assert.match(store, /lease_expires_at <= now\(\)/);
  assert.doesNotMatch(migration, /^\s*BEGIN;/m);
  assert.doesNotMatch(migration, /^\s*COMMIT;/m);
});

test("freshness validation is append-only and bound to current queue evidence", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0003_work_freshness_validation.sql"),
    "utf8",
  );
  const queueStore = await readFile(
    path.resolve(process.cwd(), "src/store/work-queue-store.ts"),
    "utf8",
  );
  const freshnessStore = await readFile(
    path.resolve(process.cwd(), "src/store/freshness-validation-store.ts"),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS work_validation_runs/);
  assert.match(migration, /work_validation_runs_immutable/);
  assert.match(migration, /queue_state_version integer NOT NULL/);
  assert.match(queueStore, /validation\.queue_state_version = w\.state_version/);
  assert.match(queueStore, /validation\.contract_content_hash = cv\.content_hash/);
  assert.match(queueStore, /cv\.version = c\.current_version/);
  assert.match(freshnessStore, /effective_authorization/);
  assert.match(freshnessStore, /change_contract_authorization_decisions/);
  assert.doesNotMatch(migration, /^\s*BEGIN;/m);
  assert.doesNotMatch(migration, /^\s*COMMIT;/m);
});

test("authorization migration makes append-only exact-version authority the execution gate", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0004_change_contract_authorization.sql"),
    "utf8",
  );
  const policy = await readFile(
    path.resolve(process.cwd(), "src/domain/contract-authorization.ts"),
    "utf8",
  );

  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS change_contract_authorization_decisions/,
  );
  assert.match(migration, /change_contract_authorization_decisions_immutable/);
  assert.match(migration, /has_effective_change_contract_authorization/);
  assert.match(migration, /execution_attempt_authorization_gate/);
  assert.match(migration, /decision IN \('AUTHORIZED', 'REVOKED'\)/);
  assert.match(policy, /facts\.riskLevel === "R4"/);
  assert.match(policy, /R3_STRENGTHENED_GATES_REQUIRED/);
  assert.doesNotMatch(migration, /^\s*BEGIN;/m);
  assert.doesNotMatch(migration, /^\s*COMMIT;/m);
});

test("AI budget migration gates exact-state leases and preserves activation separation", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0005_ai_budget_governor.sql"),
    "utf8",
  );
  const leaseStore = await readFile(
    path.resolve(process.cwd(), "src/store/budget-aware-lease-store.ts"),
    "utf8",
  );
  const budgetStore = await readFile(
    path.resolve(process.cwd(), "src/store/ai-budget-store.ts"),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS ai_budget_policies/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ai_budget_decisions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ai_budget_reservations/);
  assert.match(migration, /ai_budget_decisions_immutable/);
  assert.match(migration, /work_queue_release_stale_ai_budget_reservations/);
  assert.match(migration, /execution_attempt_budget_authorization_gate/);
  assert.match(migration, /execution_attempt_require_ai_budget_settlement/);
  assert.match(migration, /is_effective_capability_enabled/);
  assert.match(leaseStore, /latest_budget\.decision = 'APPROVED'/);
  assert.match(leaseStore, /latest_budget\.execution_class = 'DETERMINISTIC'/);
  assert.match(leaseStore, /is_effective_capability_enabled\(w\.project_id, 'AI_DISPATCH'\)/);
  assert.match(budgetStore, /FOR UPDATE/);
  assert.match(budgetStore, /PERIOD_BUDGET_EXHAUSTED|evaluateAiBudget/);
  assert.doesNotMatch(migration, /^\s*BEGIN;/m);
  assert.doesNotMatch(migration, /^\s*COMMIT;/m);
});
