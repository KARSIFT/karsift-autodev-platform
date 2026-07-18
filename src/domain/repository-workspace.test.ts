import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateWorkspaceScope,
  repositoryWorkspaceIdentity,
} from "./repository-workspace.js";

test("write workspace permits only exact or descendant scoped paths", () => {
  assert.deepEqual(
    evaluateWorkspaceScope({
      mode: "WRITE",
      allowedPaths: ["src/core", "README.md"],
      changedPaths: ["src/core/index.ts", "README.md"],
    }),
    { valid: true, violations: [] },
  );

  assert.deepEqual(
    evaluateWorkspaceScope({
      mode: "WRITE",
      allowedPaths: ["src/core"],
      changedPaths: ["src/core/index.ts", "src/other.ts"],
    }),
    { valid: false, violations: ["src/other.ts"] },
  );
});

test("read-only workspace rejects every changed path", () => {
  assert.deepEqual(
    evaluateWorkspaceScope({
      mode: "READ_ONLY",
      allowedPaths: ["src"],
      changedPaths: ["src/index.ts"],
    }),
    { valid: false, violations: ["src/index.ts"] },
  );
  assert.deepEqual(
    evaluateWorkspaceScope({
      mode: "READ_ONLY",
      allowedPaths: [],
      changedPaths: [],
    }),
    { valid: true, violations: [] },
  );
});

test("empty write scope fails closed when files change", () => {
  assert.deepEqual(
    evaluateWorkspaceScope({
      mode: "WRITE",
      allowedPaths: [],
      changedPaths: ["src/index.ts"],
    }),
    { valid: false, violations: ["src/index.ts"] },
  );
});

test("workspace identity is deterministic and collision-resistant enough for filesystem names", () => {
  const identity = repositoryWorkspaceIdentity("a".repeat(64));
  assert.deepEqual(identity, {
    workspaceKey: `ws-${"a".repeat(20)}`,
    branchName: `karsift/${"a".repeat(20)}`,
  });
  assert.throws(() => repositoryWorkspaceIdentity("bad"), /planHash/);
});
