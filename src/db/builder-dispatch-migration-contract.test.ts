import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("atomic builder dispatch migration enforces single-owner revalidated execution", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0009_atomic_builder_dispatch.sql"),
    "utf8",
  );
  const dispatchStore = await readFile(
    path.resolve(process.cwd(), "src/store/builder-dispatch-store.ts"),
    "utf8",
  );
  const service = await readFile(
    path.resolve(process.cwd(), "src/services/builder-runtime-service.ts"),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS builder_dispatch_claims/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS builder_dispatch_revalidations/);
  assert.match(migration, /builder_dispatch_one_active_idx/);
  assert.match(migration, /builder_dispatch_revalidations_immutable/);
  assert.match(migration, /builder_dispatch_claim_evidence_gate/);
  assert.match(migration, /builder_dispatch_claim_transition_gate/);
  assert.match(migration, /builder_dispatch_revalidation_evidence_gate/);
  assert.match(migration, /builder_invocation_dispatch_claim_gate/);
  assert.match(migration, /idempotency_key = 'builder-dispatch:' \|\| plan_hash/);
  assert.match(dispatchStore, /ORDER BY observation\.observed_at DESC, observation\.id DESC/);
  assert.match(dispatchStore, /evaluateLatestBuilderProviderReadiness/);
  assert.match(dispatchStore, /status = 'EXPIRED'/);
  assert.match(service, /dispatch\.acquired !== true/);
  assert.match(service, /dispatchIdempotencyKey/);
  assert.doesNotMatch(migration, /^\s*BEGIN;/m);
  assert.doesNotMatch(migration, /^\s*COMMIT;/m);
});
