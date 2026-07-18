import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("workspace read context migration enforces immutable capture leases", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0013_workspace_read_context.sql"),
    "utf8",
  );

  for (const table of [
    "workspace_read_context_requests",
    "workspace_read_context_runs",
    "workspace_read_context_snapshots",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /workspace_read_context_requests_immutable/);
  assert.match(migration, /workspace_read_context_snapshots_immutable/);
  assert.match(migration, /workspace_read_context_request_authority_gate/);
  assert.match(migration, /workspace_read_context_run_transition_gate/);
  assert.match(migration, /workspace_read_context_snapshot_binding_gate/);
  assert.match(migration, /workspace_read_context_one_capture_per_workspace_idx/);
  assert.match(migration, /workspace command is active/);
  assert.match(migration, /workspace mutation is active/);
  assert.match(migration, /workspace read context capture is active/);
  assert.match(migration, /requested path is outside relevant scope/);
  assert.match(migration, /OLD\.status = 'PREPARED' AND NEW\.status = 'CAPTURING'/);
  assert.match(migration, /OLD\.status = 'CAPTURING'/);
});
