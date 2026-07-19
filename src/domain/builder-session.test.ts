import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBuilderSessionPlanContent,
  hashBuilderSessionPlan,
  hashBuilderSessionTerminalEvidence,
  isBuilderSessionTerminal,
} from "./builder-session.js";

const plan = {
  projectId: "project-1",
  builderInvocationId: "builder-1",
  builderInvocationPlanId: "builder-plan-1",
  builderPlanHash: "a".repeat(64),
  executionAttemptId: "attempt-1",
  taskContextPackId: "pack-1",
  taskContextPackHash: "b".repeat(64),
  repositoryWorkspaceId: "workspace-1",
  repositoryWorkspacePlanId: "workspace-plan-1",
  initialReadContextRunId: "context-run-1",
  maxTurns: 3,
} as const;

test("builder session plan hashing is deterministic and exact-evidence bound", () => {
  assert.equal(hashBuilderSessionPlan(plan), hashBuilderSessionPlan(plan));
  assert.deepEqual(buildBuilderSessionPlanContent(plan), plan);
});

test("builder session terminal evidence requires exact action evidence for complete and blocked", () => {
  assert.throws(
    () =>
      hashBuilderSessionTerminalEvidence({
        outcome: "COMPLETED",
        turnCount: 1,
        finalActionEvidenceId: null,
        finalActionEvidenceHash: null,
        summary: "done",
      }),
    /require final action evidence/,
  );
  assert.match(
    hashBuilderSessionTerminalEvidence({
      outcome: "COMPLETED",
      turnCount: 1,
      finalActionEvidenceId: "action-evidence-1",
      finalActionEvidenceHash: "c".repeat(64),
      summary: "done",
    }),
    /^[a-f0-9]{64}$/,
  );
});

test("builder session terminal state classification is explicit", () => {
  assert.equal(isBuilderSessionTerminal("COMPLETED"), true);
  assert.equal(isBuilderSessionTerminal("BLOCKED"), true);
  assert.equal(isBuilderSessionTerminal("FAILED"), true);
  assert.equal(isBuilderSessionTerminal("CANCELLED"), true);
  assert.equal(isBuilderSessionTerminal("READY_FOR_TURN"), false);
});
