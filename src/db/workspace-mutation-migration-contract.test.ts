import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("workspace mutation migration preserves exact authority and immutability boundaries", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0012_workspace_mutations.sql"),
    "utf8",
  );

  for (const table of [
    "workspace_mutation_plans",
    "workspace_mutation_runs",
    "workspace_mutation_evidence",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }

  assert.match(migration, /workspace_mutation_plans_immutable/);
  assert.match(migration, /workspace_mutation_evidence_immutable/);
  assert.match(migration, /workspace_mutation_plan_authority_gate/);
  assert.match(migration, /workspace_mutation_run_transition_gate/);
  assert.match(migration, /workspace_mutation_evidence_binding_gate/);
  assert.match(migration, /workspace_mutation_one_applying_per_workspace_idx/);
  assert.match(migration, /workspace_row\.status <> 'MATERIALIZED'/);
  assert.match(migration, /workspace_plan_row\.mode <> 'WRITE'/);
  assert.match(migration, /AUTOMATED_WRITE capability is not enabled/);
  assert.match(migration, /operation path is outside relevant scope/);
  assert.match(migration, /duplicate operation paths are not allowed/);
  assert.match(migration, /per-file content limit exceeded/);
  assert.match(migration, /total content byte count does not match/);
  assert.match(migration, /OLD\.status = 'PREPARED' AND NEW\.status = 'APPLYING'/);
  assert.match(migration, /OLD\.status = 'APPLYING'/);
});
