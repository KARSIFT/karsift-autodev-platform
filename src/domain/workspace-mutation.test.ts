import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkspaceMutationScope,
  buildWorkspaceMutationPlanContent,
  hashWorkspaceMutationPlan,
  normalizeWorkspaceMutationOperations,
} from "./workspace-mutation.js";

const beforeHash = "a".repeat(64);

test("workspace mutation operations normalize and sort deterministically", () => {
  const operations = normalizeWorkspaceMutationOperations([
    {
      type: "DELETE",
      path: "src/old.ts",
      expectedBeforeHash: beforeHash,
      content: null,
    },
    {
      type: "CREATE",
      path: "src/new.ts",
      expectedBeforeHash: null,
      content: "export const created = true;\n",
    },
  ]);
  assert.deepEqual(
    operations.map((operation) => operation.path),
    ["src/new.ts", "src/old.ts"],
  );
});

test("workspace mutation operations require exact before-state semantics", () => {
  assert.throws(
    () =>
      normalizeWorkspaceMutationOperations([
        {
          type: "CREATE",
          path: "src/new.ts",
          expectedBeforeHash: beforeHash,
          content: "new",
        },
      ]),
    /CREATE requires expectedBeforeHash to be null/,
  );
  assert.throws(
    () =>
      normalizeWorkspaceMutationOperations([
        {
          type: "UPDATE",
          path: "src/file.ts",
          expectedBeforeHash: null,
          content: "changed",
        },
      ]),
    /UPDATE requires an expectedBeforeHash/,
  );
  assert.throws(
    () =>
      normalizeWorkspaceMutationOperations([
        {
          type: "DELETE",
          path: "src/file.ts",
          expectedBeforeHash: beforeHash,
          content: "unexpected",
        },
      ]),
    /DELETE must not include content/,
  );
});

test("workspace mutation plans reject duplicate and out-of-scope paths", () => {
  assert.throws(
    () =>
      normalizeWorkspaceMutationOperations([
        {
          type: "CREATE",
          path: "src/file.ts",
          expectedBeforeHash: null,
          content: "one",
        },
        {
          type: "CREATE",
          path: "src/file.ts",
          expectedBeforeHash: null,
          content: "two",
        },
      ]),
    /multiple operations for the same path/,
  );

  assert.throws(
    () =>
      assertWorkspaceMutationScope(["src/core"], [
        {
          type: "CREATE",
          path: "src/other.ts",
          expectedBeforeHash: null,
          content: "outside",
        },
      ]),
    /out-of-scope paths/,
  );
});

test("workspace mutation plan hashes bind exact operations and authority", () => {
  const input = {
    projectId: "project-1",
    repositoryWorkspaceId: "workspace-1",
    repositoryWorkspacePlanId: "workspace-plan-1",
    builderInvocationId: "builder-1",
    workspaceStateVersion: 1,
    workspacePath: "/var/lib/karsift/workspaces/ws-1",
    relevantPaths: ["src"],
    operations: [
      {
        type: "UPDATE" as const,
        path: "src/index.ts",
        expectedBeforeHash: beforeHash,
        content: "export const value = 2;\n",
      },
    ],
  };

  const content = buildWorkspaceMutationPlanContent(input);
  assert.equal((content as { totalContentBytes: number }).totalContentBytes, 24);
  assert.equal(hashWorkspaceMutationPlan(input), hashWorkspaceMutationPlan(input));
  assert.notEqual(
    hashWorkspaceMutationPlan(input),
    hashWorkspaceMutationPlan({
      ...input,
      operations: [
        {
          ...input.operations[0],
          content: "export const value = 3;\n",
        },
      ],
    }),
  );
});
