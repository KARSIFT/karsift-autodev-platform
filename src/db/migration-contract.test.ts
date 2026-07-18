import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("foundation migration encodes append-only and project-isolation constraints", async () => {
  const sql = await readFile(
    path.resolve(process.cwd(), "migrations/0001_control_plane_foundation.sql"),
    "utf8",
  );

  assert.match(sql, /change_contract_versions_immutable/);
  assert.match(sql, /audit_events_immutable/);
  assert.match(
    sql,
    /FOREIGN KEY\(change_contract_version_id, project_id\)/,
  );
  assert.match(sql, /FOREIGN KEY\(task_id, project_id\)/);
  assert.match(sql, /'AI_DISPATCH', false/);
  assert.doesNotMatch(sql, /^\s*BEGIN;/m);
  assert.doesNotMatch(sql, /^\s*COMMIT;/m);
});
