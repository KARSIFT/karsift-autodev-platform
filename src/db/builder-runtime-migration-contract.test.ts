import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("builder runtime migration enforces immutable bounded no-side-effect plans", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0008_controlled_builder_runtime.sql"),
    "utf8",
  );
  const store = await readFile(
    path.resolve(process.cwd(), "src/store/builder-runtime-store.ts"),
    "utf8",
  );
  const adapter = await readFile(
    path.resolve(process.cwd(), "src/agents/dry-run-builder-adapter.ts"),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS builder_invocation_plans/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS builder_invocations/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS builder_invocation_results/);
  assert.match(migration, /builder_invocation_plans_immutable/);
  assert.match(migration, /builder_invocation_results_immutable/);
  assert.match(migration, /builder_invocation_plan_evidence_gate/);
  assert.match(migration, /builder_invocation_transition_gate/);
  assert.match(migration, /builder_invocation_result_limit_gate/);
  assert.match(migration, /adapter_key = 'dry-run' AND side_effect_mode = 'NONE'/);
  assert.match(store, /is_effective_capability_enabled\(invocation\.project_id, 'AI_DISPATCH'\)/);
  assert.match(store, /attempt\.lease_expires_at > now\(\) AS lease_active/);
  assert.match(adapter, /externalProviderCalled: false/);
  assert.match(adapter, /repositoryMutated: false/);
  assert.doesNotMatch(migration, /^\s*BEGIN;/m);
  assert.doesNotMatch(migration, /^\s*COMMIT;/m);
});
