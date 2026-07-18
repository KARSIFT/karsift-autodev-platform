import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("Task Context Pack migration binds exact lease evidence and immutable handoff", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0006_task_context_packs.sql"),
    "utf8",
  );
  const leaseStore = await readFile(
    path.resolve(process.cwd(), "src/store/budget-aware-lease-store.ts"),
    "utf8",
  );
  const packStore = await readFile(
    path.resolve(process.cwd(), "src/store/task-context-pack-store.ts"),
    "utf8",
  );

  assert.match(migration, /claim_queue_state_version/);
  assert.match(migration, /work_validation_run_id/);
  assert.match(migration, /change_contract_authorization_decision_id/);
  assert.match(migration, /ai_budget_decision_id/);
  assert.match(migration, /execution_attempt_evidence_binding_gate/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS task_context_packs/);
  assert.match(migration, /UNIQUE\(execution_attempt_id\)/);
  assert.match(migration, /task_context_packs_immutable/);

  assert.match(leaseStore, /latest_validation\.id AS work_validation_run_id/);
  assert.match(
    leaseStore,
    /latest_authorization\.id AS change_contract_authorization_decision_id/,
  );
  assert.match(leaseStore, /latest_budget\.id AS ai_budget_decision_id/);
  assert.match(leaseStore, /claim_queue_state_version/);

  assert.match(packStore, /sha256Json\(content\)/);
  assert.match(packStore, /lease_token::text = \$2/);
  assert.doesNotMatch(packStore, /leaseToken:/);
  assert.match(packStore, /TASK_CONTEXT_PACK_CREATED/);
  assert.doesNotMatch(migration, /^\s*BEGIN;/m);
  assert.doesNotMatch(migration, /^\s*COMMIT;/m);
});
