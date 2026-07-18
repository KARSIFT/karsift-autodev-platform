import assert from "node:assert/strict";
import test from "node:test";

import {
  hashBuilderProposal,
  hashBuilderProposalRequest,
  normalizeBuilderProposal,
} from "./builder-proposal.js";

test("builder proposal action schemas are mutually exclusive", () => {
  assert.deepEqual(
    normalizeBuilderProposal(
      {
        action: "REQUEST_CONTEXT",
        summary: "Need one more source file.",
        requestedPaths: ["src/feature.ts"],
        commands: [],
        mutations: [],
        blockingReason: null,
      },
      ["src"],
    ).requestedPaths,
    ["src/feature.ts"],
  );

  assert.throws(
    () =>
      normalizeBuilderProposal(
        {
          action: "COMPLETE",
          summary: "Done.",
          requestedPaths: ["src/index.ts"],
          commands: [],
          mutations: [],
          blockingReason: null,
        },
        ["src"],
      ),
    /COMPLETE proposal must not include/,
  );
  assert.throws(
    () =>
      normalizeBuilderProposal(
        {
          action: "PROPOSE_MUTATIONS",
          summary: "Change a file.",
          requestedPaths: [],
          commands: [],
          mutations: [
            {
              type: "CREATE",
              path: "outside.txt",
              expectedBeforeHash: null,
              content: "outside",
            },
          ],
          blockingReason: null,
        },
        ["src"],
      ),
    /out-of-scope paths/,
  );
});

test("builder command proposals are structural only and bounded", () => {
  const proposal = normalizeBuilderProposal(
    {
      action: "REQUEST_COMMANDS",
      summary: "Run deterministic checks.",
      requestedPaths: [],
      commands: [
        { purpose: "TEST", executable: "npm", arguments: ["test"] },
      ],
      mutations: [],
      blockingReason: null,
    },
    ["src"],
  );
  assert.deepEqual(proposal.commands[0], {
    purpose: "TEST",
    executable: "npm",
    arguments: ["test"],
  });

  assert.throws(
    () =>
      normalizeBuilderProposal(
        {
          action: "REQUEST_COMMANDS",
          summary: "Unsafe executable.",
          requestedPaths: [],
          commands: [
            { purpose: "TEST", executable: "./script.sh", arguments: [] },
          ],
          mutations: [],
          blockingReason: null,
        },
        ["src"],
      ),
    /bare command name/,
  );
});

test("builder proposal request and proposal hashes bind exact immutable inputs", () => {
  const request = {
    projectId: "project-1",
    builderInvocationId: "builder-1",
    builderInvocationPlanId: "builder-plan-1",
    builderPlanHash: "a".repeat(64),
    executionAttemptId: "attempt-1",
    taskContextPackId: "tcp-1",
    taskContextPackHash: "b".repeat(64),
    providerDispatchDecisionId: "dispatch-1",
    providerKey: "fixture-provider",
    workspaceReadContextSnapshotId: "snapshot-1",
    workspaceReadContextSnapshotHash: "c".repeat(64),
    relevantPaths: ["src"],
    taskContextPackContent: { objective: "implement feature" },
    sourceSnapshotContent: { files: [{ path: "src/index.ts", content: "x" }] },
  };
  assert.equal(hashBuilderProposalRequest(request), hashBuilderProposalRequest(request));
  assert.notEqual(
    hashBuilderProposalRequest(request),
    hashBuilderProposalRequest({ ...request, providerKey: "other-provider" }),
  );

  const proposal = {
    action: "COMPLETE" as const,
    summary: "No changes required.",
    requestedPaths: [],
    commands: [],
    mutations: [],
    blockingReason: null,
  };
  assert.equal(hashBuilderProposal(proposal, ["src"]), hashBuilderProposal(proposal, ["src"]));
});
