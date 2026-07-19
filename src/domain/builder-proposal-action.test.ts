import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBuilderProposalActionDecisionContent,
  hashBuilderProposalActionDecision,
  hashBuilderProposalActionResult,
  normalizeBuilderProposalActionEntities,
} from "./builder-proposal-action.js";

const decisionInput = {
  projectId: "project-1",
  builderInvocationId: "builder-1",
  builderProposalRequestId: "request-1",
  builderProposalRunId: "proposal-run-1",
  builderProposalEvidenceId: "proposal-evidence-1",
  proposalHash: "a".repeat(64),
  action: "REQUEST_COMMANDS" as const,
  turnNumber: 2,
  repositoryWorkspaceId: "workspace-1",
  workspaceStateVersion: 3,
  taskContextPackId: "pack-1",
  taskContextPackHash: "b".repeat(64),
  commandPolicyId: "policy-1",
  commandPolicyHash: "c".repeat(64),
};

test("proposal action decision hashing is deterministic and exact-evidence bound", () => {
  const content = buildBuilderProposalActionDecisionContent(decisionInput);
  assert.equal(hashBuilderProposalActionDecision(decisionInput), hashBuilderProposalActionDecision(decisionInput));
  assert.deepEqual(content, {
    projectId: "project-1",
    builderInvocationId: "builder-1",
    builderProposalRequestId: "request-1",
    builderProposalRunId: "proposal-run-1",
    builderProposalEvidenceId: "proposal-evidence-1",
    proposalHash: "a".repeat(64),
    action: "REQUEST_COMMANDS",
    turnNumber: 2,
    repositoryWorkspaceId: "workspace-1",
    workspaceStateVersion: 3,
    taskContextPackId: "pack-1",
    taskContextPackHash: "b".repeat(64),
    commandPolicyId: "policy-1",
    commandPolicyHash: "c".repeat(64),
  });
});

test("proposal action decision rejects incomplete command policy evidence", () => {
  assert.throws(
    () =>
      buildBuilderProposalActionDecisionContent({
        ...decisionInput,
        commandPolicyHash: null,
      }),
    /both be present or both be null/,
  );
});

test("materialized entity evidence is ordinal-normalized before hashing", () => {
  const entities = normalizeBuilderProposalActionEntities([
    { kind: "WORKSPACE_COMMAND", ordinal: 1, recordId: "plan-2", runId: "run-2" },
    { kind: "WORKSPACE_COMMAND", ordinal: 0, recordId: "plan-1", runId: "run-1" },
  ]);
  assert.deepEqual(entities.map((entity) => entity.ordinal), [0, 1]);
  const first = hashBuilderProposalActionResult({
    action: "REQUEST_COMMANDS",
    outcome: "RESULT_READY",
    materializedEntities: entities,
    results: [{ status: "SUCCEEDED" }],
  });
  const second = hashBuilderProposalActionResult({
    action: "REQUEST_COMMANDS",
    outcome: "RESULT_READY",
    materializedEntities: [...entities].reverse(),
    results: [{ status: "SUCCEEDED" }],
  });
  assert.equal(first, second);
});
