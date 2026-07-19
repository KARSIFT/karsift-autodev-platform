import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("proposal action migration preserves bounded orchestration and next-turn authority", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0015_builder_proposal_action_orchestration.sql"),
    "utf8",
  );

  for (const table of [
    "builder_proposal_action_decisions",
    "builder_proposal_action_runs",
    "builder_proposal_action_evidence",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /builder_proposal_action_decisions_immutable/);
  assert.match(migration, /builder_proposal_action_evidence_immutable/);
  assert.match(migration, /builder_proposal_action_one_active_per_invocation_idx/);
  assert.match(migration, /builder_proposal_action_decision_authority_gate/);
  assert.match(migration, /builder_proposal_action_run_transition_gate/);
  assert.match(migration, /builder_proposal_action_evidence_binding_gate/);
  assert.match(migration, /builder_proposal_next_turn_authority_gate/);
  assert.match(migration, /previous_action_evidence_id/);
  assert.match(migration, /prior_proposal_count >= plan_row\.max_turns/);
  assert.match(migration, /is_effective_capability_enabled\(NEW\.project_id, 'AUTOMATED_WRITE'\)/);
  assert.match(migration, /workspace_command_policies/);
  assert.match(migration, /workspace_read_context_runs/);
  assert.match(migration, /workspace_mutation_runs/);
});
