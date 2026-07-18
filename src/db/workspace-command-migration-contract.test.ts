import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("workspace command migration preserves governed execution boundaries", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0011_workspace_commands.sql"),
    "utf8",
  );

  for (const table of [
    "workspace_command_policies",
    "workspace_command_plans",
    "workspace_command_runs",
    "workspace_command_evidence",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }

  assert.match(migration, /workspace_command_policies_immutable/);
  assert.match(migration, /workspace_command_plans_immutable/);
  assert.match(migration, /workspace_command_evidence_immutable/);
  assert.match(migration, /workspace_command_plan_authority_gate/);
  assert.match(migration, /workspace_command_run_transition_gate/);
  assert.match(migration, /workspace_command_evidence_binding_gate/);
  assert.match(migration, /workspace_row\.status <> 'MATERIALIZED'/);
  assert.match(migration, /workspace_row\.state_version <> NEW\.workspace_state_version/);
  assert.match(migration, /AUTOMATED_WRITE capability is not enabled/);
  assert.match(migration, /workspace command budget is exhausted/i);
  assert.match(migration, /executable or arguments are not allowed by policy/i);
  assert.match(migration, /environment contains a key not allowed by policy/i);
  assert.match(migration, /OLD\.status = 'PREPARED' AND NEW\.status = 'RUNNING'/);
  assert.match(migration, /OLD\.status = 'RUNNING'/);
});
