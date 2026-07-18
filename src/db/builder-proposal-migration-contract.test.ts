import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("builder proposal migration preserves dispatch authority and immutable evidence", async () => {
  const migration = await readFile(
    path.resolve(process.cwd(), "migrations/0014_builder_proposals.sql"),
    "utf8",
  );

  for (const table of [
    "builder_proposal_requests",
    "builder_proposal_runs",
    "builder_proposal_evidence",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /adapter_key text NOT NULL CHECK \(adapter_key = 'fixture-proposal'\)/);
  assert.match(migration, /external_provider_called boolean NOT NULL CHECK \(external_provider_called = false\)/);
  assert.match(migration, /builder_proposal_requests_immutable/);
  assert.match(migration, /builder_proposal_evidence_immutable/);
  assert.match(migration, /builder_proposal_request_authority_gate/);
  assert.match(migration, /builder_proposal_run_transition_gate/);
  assert.match(migration, /builder_proposal_evidence_binding_gate/);
  assert.match(migration, /builder_proposal_one_generating_per_invocation_idx/);
  assert.match(migration, /claim_row\.status <> 'ACTIVE'/);
  assert.match(migration, /revalidation_row\.outcome <> 'READY'/);
  assert.match(migration, /revalidation_row\.selected_provider_key <> request_row\.provider_key/);
  assert.match(migration, /OLD\.status = 'PREPARED' AND NEW\.status = 'GENERATING'/);
  assert.match(migration, /OLD\.status = 'GENERATING'/);
});
