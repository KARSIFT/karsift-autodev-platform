import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BoundedWorkspaceCommandRunner } from "./bounded-workspace-command-runner.js";

async function withWorkspace(
  operation: (runner: BoundedWorkspaceCommandRunner, workspacePath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "karsift-command-test-"));
  const workspaceRoot = path.join(root, "workspaces");
  const workspacePath = path.join(workspaceRoot, "ws-1");
  await mkdir(workspacePath, { recursive: true });
  try {
    await operation(new BoundedWorkspaceCommandRunner(workspaceRoot), workspacePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("bounded runner does not inherit provider credentials", async () => {
  await withWorkspace(async (runner, workspacePath) => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "must-not-leak";
    try {
      const result = await runner.execute({
        workspacePath,
        executable: process.execPath,
        arguments: [
          "-e",
          "process.exit(process.env.OPENAI_API_KEY === undefined ? 0 : 9)",
        ],
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
        environment: {},
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      assert.equal(result.errorCode, null);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });
});

test("bounded runner enforces timeout and output capture limits", async () => {
  await withWorkspace(async (runner, workspacePath) => {
    const output = await runner.execute({
      workspacePath,
      executable: process.execPath,
      arguments: ["-e", "process.stdout.write('x'.repeat(10000))"],
      timeoutMs: 5_000,
      maxOutputBytes: 128,
      environment: {},
    });
    assert.equal(output.exitCode, 0);
    assert.equal(output.stdoutBytes, 10_000);
    assert.equal(output.stdoutTruncated, true);
    assert.match(output.stdoutSha256, /^[a-f0-9]{64}$/);

    const timeout = await runner.execute({
      workspacePath,
      executable: process.execPath,
      arguments: ["-e", "setTimeout(() => {}, 5000)"],
      timeoutMs: 50,
      maxOutputBytes: 128,
      environment: {},
    });
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.exitCode, null);
    assert.equal(timeout.signal === "SIGTERM" || timeout.signal === "SIGKILL", true);
  });
});

test("bounded runner rejects paths outside the configured workspace root", async () => {
  await withWorkspace(async (runner) => {
    await assert.rejects(
      () =>
        runner.execute({
          workspacePath: os.tmpdir(),
          executable: process.execPath,
          arguments: ["--version"],
          timeoutMs: 1_000,
          maxOutputBytes: 1_024,
          environment: {},
        }),
      /child of the configured workspace root/,
    );
  });
});
