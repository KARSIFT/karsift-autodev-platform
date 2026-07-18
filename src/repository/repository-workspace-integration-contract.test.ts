import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("repository workspace subsystem is wired into runtime and canonical validation", async () => {
  const [main, dockerfile, packageJson, workflow, foundation] = await Promise.all([
    readFile(path.resolve(process.cwd(), "src/main.ts"), "utf8"),
    readFile(path.resolve(process.cwd(), "Dockerfile"), "utf8"),
    readFile(path.resolve(process.cwd(), "package.json"), "utf8"),
    readFile(
      path.resolve(process.cwd(), ".github/workflows/control-plane-ci.yml"),
      "utf8",
    ),
    readFile(
      path.resolve(process.cwd(), "scripts/verify-postgres-foundation.mjs"),
      "utf8",
    ),
  ]);

  assert.match(main, /attachRepositoryWorkspaceRoute/);
  assert.match(main, /createRepositoryWorkspaceRuntime/);
  assert.match(dockerfile, /apk add --no-cache git/);
  assert.match(dockerfile, /\/var\/lib\/karsift\/repositories/);
  assert.match(dockerfile, /\/var\/lib\/karsift\/workspaces/);
  assert.match(packageJson, /verify:repository-workspace/);
  assert.match(workflow, /Verify isolated repository workspaces and scope enforcement/);
  assert.match(foundation, /repository_workspace_plans/);
  assert.match(foundation, /repository_workspace_evidence/);
  assert.match(foundation, /0010_repository_workspaces\.sql/);
});
