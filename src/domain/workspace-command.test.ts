import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkspaceCommandAllowed,
  buildWorkspaceCommandPlanContent,
  hashWorkspaceCommandPlan,
  hashWorkspaceCommandPolicy,
  normalizeWorkspaceCommandPolicy,
  type WorkspaceCommandPolicySnapshot,
} from "./workspace-command.js";

const policy: WorkspaceCommandPolicySnapshot = {
  purposes: ["TEST", "BUILD", "TEST"],
  rules: [
    { executable: "npm", allowedArguments: [["test"], ["run", "build"]] },
    { executable: "node", allowedArguments: [["--version"]] },
  ],
  environmentAllowlist: ["KARSIFT_TEST_FLAG"],
  maxTimeoutMs: 30_000,
  maxOutputBytes: 64_000,
  maxCommandsPerWorkspace: 8,
};

test("workspace command policies normalize deterministically", () => {
  const normalized = normalizeWorkspaceCommandPolicy(policy);
  assert.deepEqual(normalized.purposes, ["BUILD", "TEST"]);
  assert.deepEqual(
    normalized.rules.map((rule) => rule.executable),
    ["node", "npm"],
  );
  assert.match(hashWorkspaceCommandPolicy(policy), /^[a-f0-9]{64}$/);
});

test("workspace command policy requires exact executable and argument vectors", () => {
  assert.doesNotThrow(() =>
    assertWorkspaceCommandAllowed(policy, {
      purpose: "TEST",
      executable: "npm",
      arguments: ["test"],
      timeoutMs: 10_000,
      maxOutputBytes: 8_000,
      environment: { KARSIFT_TEST_FLAG: "1" },
    }),
  );

  assert.throws(
    () =>
      assertWorkspaceCommandAllowed(policy, {
        purpose: "TEST",
        executable: "npm",
        arguments: ["test", "--", "--watch"],
        timeoutMs: 10_000,
        maxOutputBytes: 8_000,
        environment: {},
      }),
    /arguments are not allowed/,
  );
  assert.throws(
    () =>
      assertWorkspaceCommandAllowed(policy, {
        purpose: "TEST",
        executable: "sh",
        arguments: ["-c", "echo unsafe"],
        timeoutMs: 10_000,
        maxOutputBytes: 8_000,
        environment: {},
      }),
    /executable is not allowed/,
  );
});

test("workspace command policy blocks undelegated and reserved environment keys", () => {
  assert.throws(
    () =>
      assertWorkspaceCommandAllowed(policy, {
        purpose: "BUILD",
        executable: "npm",
        arguments: ["run", "build"],
        timeoutMs: 10_000,
        maxOutputBytes: 8_000,
        environment: { OPENAI_API_KEY: "secret" },
      }),
    /environment key is not allowed|reserved environment key/,
  );

  assert.throws(
    () =>
      normalizeWorkspaceCommandPolicy({
        ...policy,
        environmentAllowlist: ["GITHUB_TOKEN"],
      }),
    /reserved environment key/,
  );
});

test("workspace command plans hash exact authority and execution inputs", () => {
  const input = {
    projectId: "project-1",
    repositoryWorkspaceId: "workspace-1",
    repositoryWorkspacePlanId: "workspace-plan-1",
    policyId: "policy-1",
    policyHash: "a".repeat(64),
    workspaceStateVersion: 1,
    workspacePath: "/var/lib/karsift/workspaces/ws-1",
    workspaceMode: "READ_ONLY" as const,
    purpose: "INSPECT" as const,
    executable: "node",
    arguments: ["--version"],
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    environment: { Z_FLAG: "2", A_FLAG: "1" },
  };

  const content = buildWorkspaceCommandPlanContent(input);
  assert.deepEqual((content as { environment: Record<string, string> }).environment, {
    A_FLAG: "1",
    Z_FLAG: "2",
  });
  assert.equal(hashWorkspaceCommandPlan(input), hashWorkspaceCommandPlan(input));
  assert.notEqual(
    hashWorkspaceCommandPlan(input),
    hashWorkspaceCommandPlan({ ...input, arguments: ["--help"] }),
  );
});
