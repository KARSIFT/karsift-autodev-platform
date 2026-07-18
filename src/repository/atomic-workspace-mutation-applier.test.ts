import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AtomicWorkspaceMutationApplier } from "./atomic-workspace-mutation-applier.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function withWorkspace(
  operation: (root: string, workspacePath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "karsift-mutation-test-"));
  const workspaceRoot = path.join(root, "workspaces");
  const workspacePath = path.join(workspaceRoot, "ws-1");
  await mkdir(path.join(workspacePath, "src"), { recursive: true });
  try {
    await operation(workspaceRoot, workspacePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("atomic workspace mutation applies create, update, and delete with evidence", async () => {
  await withWorkspace(async (workspaceRoot, workspacePath) => {
    await writeFile(path.join(workspacePath, "src", "update.txt"), "before update\n");
    await writeFile(path.join(workspacePath, "src", "delete.txt"), "delete me\n");

    const result = await new AtomicWorkspaceMutationApplier(workspaceRoot).apply({
      workspacePath,
      operations: [
        {
          type: "CREATE",
          path: "src/create.txt",
          expectedBeforeHash: null,
          content: "created\n",
        },
        {
          type: "UPDATE",
          path: "src/update.txt",
          expectedBeforeHash: sha256("before update\n"),
          content: "after update\n",
        },
        {
          type: "DELETE",
          path: "src/delete.txt",
          expectedBeforeHash: sha256("delete me\n"),
          content: null,
        },
      ],
    });

    assert.equal(await readFile(path.join(workspacePath, "src", "create.txt"), "utf8"), "created\n");
    assert.equal(
      await readFile(path.join(workspacePath, "src", "update.txt"), "utf8"),
      "after update\n",
    );
    await assert.rejects(
      () => readFile(path.join(workspacePath, "src", "delete.txt")),
      /ENOENT/,
    );
    assert.deepEqual(
      result.pathEvidence.map((entry) => [entry.type, entry.path]),
      [
        ["CREATE", "src/create.txt"],
        ["DELETE", "src/delete.txt"],
        ["UPDATE", "src/update.txt"],
      ],
    );
  });
});

test("atomic workspace mutation rejects stale before hashes before changing files", async () => {
  await withWorkspace(async (workspaceRoot, workspacePath) => {
    const target = path.join(workspacePath, "src", "file.txt");
    await writeFile(target, "original\n");
    await assert.rejects(
      () =>
        new AtomicWorkspaceMutationApplier(workspaceRoot).apply({
          workspacePath,
          operations: [
            {
              type: "UPDATE",
              path: "src/file.txt",
              expectedBeforeHash: "a".repeat(64),
              content: "changed\n",
            },
          ],
        }),
      /before hash does not match/,
    );
    assert.equal(await readFile(target, "utf8"), "original\n");
  });
});

test("atomic workspace mutation rolls back earlier writes after a mid-apply failure", async () => {
  await withWorkspace(async (workspaceRoot, workspacePath) => {
    const first = path.join(workspacePath, "src", "a.txt");
    const second = path.join(workspacePath, "src", "b.txt");
    await writeFile(first, "a-before\n");
    await writeFile(second, "b-before\n");

    const applier = new AtomicWorkspaceMutationApplier(
      workspaceRoot,
      (operationIndex) => {
        if (operationIndex === 1) {
          throw new Error("injected mutation failure");
        }
      },
    );
    await assert.rejects(
      () =>
        applier.apply({
          workspacePath,
          operations: [
            {
              type: "UPDATE",
              path: "src/a.txt",
              expectedBeforeHash: sha256("a-before\n"),
              content: "a-after\n",
            },
            {
              type: "UPDATE",
              path: "src/b.txt",
              expectedBeforeHash: sha256("b-before\n"),
              content: "b-after\n",
            },
          ],
        }),
      /injected mutation failure/,
    );
    assert.equal(await readFile(first, "utf8"), "a-before\n");
    assert.equal(await readFile(second, "utf8"), "b-before\n");
  });
});

test("atomic workspace mutation rejects symlink traversal", async () => {
  await withWorkspace(async (workspaceRoot, workspacePath) => {
    const external = path.join(path.dirname(workspaceRoot), "external");
    await mkdir(external, { recursive: true });
    await symlink(external, path.join(workspacePath, "linked"));

    await assert.rejects(
      () =>
        new AtomicWorkspaceMutationApplier(workspaceRoot).apply({
          workspacePath,
          operations: [
            {
              type: "CREATE",
              path: "linked/escape.txt",
              expectedBeforeHash: null,
              content: "escape",
            },
          ],
        }),
      /symlink or non-directory/,
    );
  });
});
