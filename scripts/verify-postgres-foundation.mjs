import assert from "node:assert/strict";

import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString: databaseUrl });

async function expectRejected(client, operation, message) {
  await client.query("SAVEPOINT invariant_check");
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT invariant_check");
    await client.query("RELEASE SAVEPOINT invariant_check");
  }
  assert.equal(rejected, true, message);
}

const client = await pool.connect();
try {
  const expectedTables = [
    "ai_budget_decisions",
    "ai_budget_policies",
    "ai_budget_reservations",
    "ai_provider_capacity_observations",
    "ai_provider_dispatch_decisions",
    "ai_provider_routing_policies",
    "audit_events",
    "builder_dispatch_claims",
    "builder_dispatch_revalidations",
    "builder_invocation_plans",
    "builder_invocation_results",
    "builder_invocations",
    "builder_proposal_evidence",
    "builder_proposal_requests",
    "builder_proposal_runs",
    "capability_switches",
    "change_contract_authorization_decisions",
    "change_contract_versions",
    "change_contracts",
    "decisions",
    "execution_attempts",
    "founder_requests",
    "projects",
    "repository_workspace_evidence",
    "repository_workspace_plans",
    "repository_workspaces",
    "schema_migrations",
    "task_context_packs",
    "tasks",
    "work_queue_items",
    "work_validation_runs",
    "workflow_runs",
    "workspace_command_evidence",
    "workspace_command_plans",
    "workspace_command_policies",
    "workspace_command_runs",
    "workspace_mutation_evidence",
    "workspace_mutation_plans",
    "workspace_mutation_runs",
    "workspace_read_context_requests",
    "workspace_read_context_runs",
    "workspace_read_context_snapshots",
  ].sort();

  const tables = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name).sort(),
    expectedTables,
    "migrations must create exactly the expected public tables",
  );

  const migrations = await client.query(
    "SELECT filename FROM schema_migrations ORDER BY filename",
  );
  assert.deepEqual(
    migrations.rows.map((row) => row.filename),
    [
      "0001_control_plane_foundation.sql",
      "0002_work_queue_execution_leases.sql",
      "0003_work_freshness_validation.sql",
      "0004_change_contract_authorization.sql",
      "0005_ai_budget_governor.sql",
      "0006_task_context_packs.sql",
      "0007_provider_dispatch_readiness.sql",
      "0008_controlled_builder_runtime.sql",
      "0009_atomic_builder_dispatch.sql",
      "0010_repository_workspaces.sql",
      "0011_workspace_commands.sql",
      "0012_workspace_mutations.sql",
      "0013_workspace_read_context.sql",
      "0014_builder_proposals.sql",
    ],
    "all foundation migrations must be recorded exactly once",
  );

  const switches = await client.query(
    `SELECT capability, enabled
       FROM capability_switches
      WHERE scope_type = 'GLOBAL'
      ORDER BY capability`,
  );
  assert.equal(switches.rowCount, 6, "all six global capability switches must exist");
  assert.equal(
    switches.rows.every((row) => row.enabled === false),
    true,
    "all autonomous capability switches must remain disabled",
  );

  await client.query("BEGIN");
  try {
    const projectOne = await client.query(
      `INSERT INTO projects(slug, name, repository_full_name)
       VALUES ('ci-project-one', 'CI Project One', 'KARSIFT/ci-project-one')
       RETURNING id`,
    );
    const projectTwo = await client.query(
      `INSERT INTO projects(slug, name, repository_full_name)
       VALUES ('ci-project-two', 'CI Project Two', 'KARSIFT/ci-project-two')
       RETURNING id`,
    );
    const projectOneId = projectOne.rows[0].id;
    const projectTwoId = projectTwo.rows[0].id;

    const contract = await client.query(
      `INSERT INTO change_contracts(project_id, stable_id)
       VALUES ($1, 'ADP-CI-001')
       RETURNING id`,
      [projectOneId],
    );
    const version = await client.query(
      `INSERT INTO change_contract_versions(
         contract_id, project_id, version, content, content_hash, created_by
       ) VALUES (
         $1, $2, 1, '{"objective":"ci"}'::jsonb, repeat('a', 64), 'ci'
       )
       RETURNING id`,
      [contract.rows[0].id, projectOneId],
    );
    const versionId = version.rows[0].id;
    const audit = await client.query(
      `INSERT INTO audit_events(
         project_id, actor_type, actor_id, action, entity_type, entity_id
       ) VALUES ($1, 'SYSTEM', 'ci', 'VERIFY', 'change_contract_version', $2)
       RETURNING id`,
      [projectOneId, versionId],
    );

    await expectRejected(
      client,
      () =>
        client.query(
          `UPDATE change_contract_versions
              SET content = '{"objective":"mutated"}'::jsonb
            WHERE id = $1`,
          [versionId],
        ),
      "change_contract_versions must reject UPDATE operations",
    );
    await expectRejected(
      client,
      () => client.query("DELETE FROM audit_events WHERE id = $1", [audit.rows[0].id]),
      "audit_events must reject DELETE operations",
    );
    await expectRejected(
      client,
      () =>
        client.query(
          `INSERT INTO tasks(project_id, change_contract_version_id, title, description)
           VALUES ($1, $2, 'Cross-project task', 'Must be rejected')`,
          [projectTwoId, versionId],
        ),
      "cross-project references must be rejected by composite foreign keys",
    );
  } finally {
    await client.query("ROLLBACK");
  }

  console.log("PostgreSQL foundation invariants verified successfully.");
} finally {
  client.release();
  await pool.end();
}
