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

test("freshness validation is append-only and lease claiming requires current valid evidence", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0003_work_freshness_validation.sql"),
    "utf8",
  );
  const queueStore = await readFile(
    path.resolve(process.cwd(), "src/store/work-queue-store.ts"),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS work_validation_runs/);
  assert.match(migration, /work_validation_runs_immutable/);
  assert.match(migration, /queue_state_version integer NOT NULL/);
  assert.match(queueStore, /validation\.queue_state_version = w\.state_version/);
  assert.match(queueStore, /validation\.contract_content_hash = cv\.content_hash/);
  assert.match(queueStore, /c\.status = 'AUTHORIZED'/);
  assert.match(queueStore, /cv\.version = c\.current_version/);
  assert.doesNotMatch(migration, /^\s*BEGIN;/m);
  assert.doesNotMatch(migration, /^\s*COMMIT;/m);
});
