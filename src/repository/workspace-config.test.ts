import assert from "node:assert/strict";
import test from "node:test";

import { loadRepositoryWorkspaceConfig } from "./workspace-config.js";

test("repository workspace roots default to separate dedicated directories", () => {
  assert.deepEqual(loadRepositoryWorkspaceConfig({}), {
    sourceRoot: "/var/lib/karsift/repositories",
    workspaceRoot: "/var/lib/karsift/workspaces",
  });
});

test("repository workspace roots can be explicitly overridden", () => {
  assert.deepEqual(
    loadRepositoryWorkspaceConfig({
      REPOSITORY_SOURCE_ROOT: "/tmp/karsift-sources",
      REPOSITORY_WORKSPACE_ROOT: "/tmp/karsift-workspaces",
    }),
    {
      sourceRoot: "/tmp/karsift-sources",
      workspaceRoot: "/tmp/karsift-workspaces",
    },
  );
});

test("source and workspace roots must be different", () => {
  assert.throws(
    () =>
      loadRepositoryWorkspaceConfig({
        REPOSITORY_SOURCE_ROOT: "/tmp/same",
        REPOSITORY_WORKSPACE_ROOT: "/tmp/same",
      }),
    /must be different/,
  );
});
