import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildWorkspaceReadContextSnapshotContent,
  hashWorkspaceReadContextRequest,
  hashWorkspaceReadContextSnapshot,
  isProtectedReadContextPath,
  normalizeWorkspaceReadContextRequestedPaths,
} from "./workspace-read-context.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("workspace read context requested paths are normalized and scope checked", () => {
  assert.deepEqual(
    normalizeWorkspaceReadContextRequestedPaths(
      ["src/core", "src/core/index.ts", "src/core"],
      ["src"],
    ),
    ["src/core", "src/core/index.ts"],
  );
  assert.throws(
    () => normalizeWorkspaceReadContextRequestedPaths(["docs"], ["src"]),
    /outside relevant scope/,
  );
});

test("workspace read context protected path policy rejects repository metadata and local-only files", () => {
  for (const protectedPath of [
    ".git/config",
    "src/.env",
    "src/.env.local",
    "config/credentials.json",
    "keys/signing.pem",
  ]) {
    assert.equal(isProtectedReadContextPath(protectedPath), true);
  }
  assert.equal(isProtectedReadContextPath("src/index.ts"), false);
});

test("workspace read context request and snapshot hashes bind exact authority and content", () => {
  const request = {
    projectId: "project-1",
    repositoryWorkspaceId: "workspace-1",
    repositoryWorkspacePlanId: "workspace-plan-1",
    builderInvocationId: "builder-1",
    taskContextPackId: "tcp-1",
    taskContextPackHash: "a".repeat(64),
    workspaceStateVersion: 1,
    workspacePath: "/var/lib/karsift/workspaces/ws-1",
    relevantPaths: ["src"],
    requestedPaths: ["src"],
  };
  const requestHash = hashWorkspaceReadContextRequest(request);
  const snapshot = {
    ...request,
    requestHash,
    files: [
      {
        path: "src/index.ts",
        content: "export const value = 1;\n",
        contentHash: sha256("export const value = 1;\n"),
        bytes: Buffer.byteLength("export const value = 1;\n", "utf8"),
      },
    ],
  };
  const content = buildWorkspaceReadContextSnapshotContent(snapshot);
  assert.equal((content as { fileCount: number }).fileCount, 1);
  assert.equal(hashWorkspaceReadContextSnapshot(snapshot), hashWorkspaceReadContextSnapshot(snapshot));
  assert.notEqual(
    hashWorkspaceReadContextSnapshot(snapshot),
    hashWorkspaceReadContextSnapshot({
      ...snapshot,
      files: [
        {
          path: "src/index.ts",
          content: "export const value = 2;\n",
          contentHash: sha256("export const value = 2;\n"),
          bytes: Buffer.byteLength("export const value = 2;\n", "utf8"),
        },
      ],
    }),
  );
});
