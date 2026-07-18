import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("repository workspace migration enforces exact evidence and independent write capability", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0010_repository_workspaces.sql"),
    "utf8",
  );
  const store = await readFile(
    path.resolve(process.cwd(), "src/store/repository-workspace-store.ts"),
    "utf8",
  );
  const adapter = await readFile(
    path.resolve(process.cwd(), "src/repository/local-git-workspace-adapter.ts"),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS repository_workspace_plans/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS repository_workspaces/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS repository_workspace_evidence/);
  assert.match(migration, /repository_workspace_plans_immutable/);
  assert.match(migration, /repository_workspace_evidence_immutable/);
  assert.match(migration, /repository_workspace_plan_evidence_gate/);
  assert.match(migration, /repository_workspace_transition_gate/);
  assert.match(migration, /repository_workspace_evidence_binding_gate/);
  assert.match(migration, /is_effective_capability_enabled\(NEW\.project_id, 'AUTOMATED_WRITE'\)/);
  assert.match(migration, /context_pack_row\.base_commit_sha <> NEW\.base_commit_sha/);
  assert.match(store, /evaluateWorkspaceScope/);
  assert.match(store, /hashRepositoryWorkspacePlan/);
  assert.match(adapter, /GIT_TERMINAL_PROMPT: "0"/);
  assert.match(adapter, /--no-hardlinks/);
  assert.doesNotMatch(migration, /^\s*BEGIN;/m);
  assert.doesNotMatch(migration, /^\s*COMMIT;/m);
});
