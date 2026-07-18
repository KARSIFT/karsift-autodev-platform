import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceReadContextCapturer } from "./workspace-read-context-capturer.js";

async function withWorkspace(
  operation: (
    capturer: WorkspaceReadContextCapturer,
    workspacePath: string,
    root: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "karsift-read-context-test-"));
  const workspaceRoot = path.join(root, "workspaces");
  const workspacePath = path.join(workspaceRoot, "ws-1");
  await mkdir(path.join(workspacePath, "src", "nested"), { recursive: true });
  try {
    await operation(new WorkspaceReadContextCapturer(workspaceRoot), workspacePath, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("workspace read context captures directories deterministically", async () => {
  await withWorkspace(async (capturer, workspacePath) => {
    await writeFile(path.join(workspacePath, "src", "z.ts"), "export const z = 1;\n");
    await writeFile(path.join(workspacePath, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(
      path.join(workspacePath, "src", "nested", "b.ts"),
      "export const b = 1;\n",
    );

    const files = await capturer.capture({
      workspacePath,
      relevantPaths: ["src"],
      requestedPaths: ["src"],
    });
    assert.deepEqual(
      files.map((file) => file.path),
      ["src/a.ts", "src/nested/b.ts", "src/z.ts"],
    );
    assert.equal(files.every((file) => /^[a-f0-9]{64}$/.test(file.contentHash)), true);
  });
});

test("workspace read context rejects protected and symlinked paths", async () => {
  await withWorkspace(async (capturer, workspacePath, root) => {
    await writeFile(path.join(workspacePath, "src", ".env"), "LOCAL_ONLY=1\n");
    await assert.rejects(
      () =>
        capturer.capture({
          workspacePath,
          relevantPaths: ["src"],
          requestedPaths: ["src"],
        }),
      /protected path/,
    );

    await rm(path.join(workspacePath, "src", ".env"));
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "outside\n");
    await symlink(outside, path.join(workspacePath, "src", "linked"));
    await assert.rejects(
      () =>
        capturer.capture({
          workspacePath,
          relevantPaths: ["src"],
          requestedPaths: ["src"],
        }),
      /symlink is not allowed/,
    );
  });
});

test("workspace read context rejects non-UTF-8 files", async () => {
  await withWorkspace(async (capturer, workspacePath) => {
    await writeFile(path.join(workspacePath, "src", "binary.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    await assert.rejects(
      () =>
        capturer.capture({
          workspacePath,
          relevantPaths: ["src"],
          requestedPaths: ["src"],
        }),
      /not valid UTF-8 text/,
    );
  });
});
