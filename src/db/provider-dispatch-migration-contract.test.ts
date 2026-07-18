import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("provider dispatch migration binds exact readiness evidence to AI execution", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0007_provider_dispatch_readiness.sql"),
    "utf8",
  );
  const leaseStore = await readFile(
    path.resolve(process.cwd(), "src/store/budget-aware-lease-store.ts"),
    "utf8",
  );
  const contextPackStore = await readFile(
    path.resolve(process.cwd(), "src/store/task-context-pack-store.ts"),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS ai_provider_routing_policies/);
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS ai_provider_capacity_observations/,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS ai_provider_dispatch_decisions/,
  );
  assert.match(migration, /ai_provider_capacity_observations_immutable/);
  assert.match(migration, /ai_provider_dispatch_decisions_immutable/);
  assert.match(migration, /execution_attempt_provider_dispatch_gate/);
  assert.match(migration, /provider_dispatch_decision_id/);
  assert.match(migration, /latest exact-state dispatch decision/);
  assert.match(leaseStore, /latest_dispatch\.outcome = 'READY'/);
  assert.match(leaseStore, /latest_dispatch\.observation_status = 'HEALTHY'/);
  assert.match(leaseStore, /provider_dispatch_decision_id/);
  assert.match(contextPackStore, /providerDispatch: providerDispatchEvidence/);
  assert.match(contextPackStore, /routingPolicyVersion/);
  assert.doesNotMatch(migration, /^\s*BEGIN;/m);
  assert.doesNotMatch(migration, /^\s*COMMIT;/m);
});
