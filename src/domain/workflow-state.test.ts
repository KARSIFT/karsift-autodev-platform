import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkflowTransition,
  canTransitionWorkflow,
  isTerminalWorkflowStatus,
} from "./workflow-state.js";

test("workflow state machine allows bounded forward transitions", () => {
  assert.equal(canTransitionWorkflow("CREATED", "RUNNING"), true);
  assert.equal(canTransitionWorkflow("RUNNING", "SUCCEEDED"), true);
  assert.equal(canTransitionWorkflow("BLOCKED", "RUNNING"), true);
});

test("terminal workflow states cannot transition", () => {
  for (const status of ["SUCCEEDED", "FAILED", "CANCELLED"] as const) {
    assert.equal(isTerminalWorkflowStatus(status), true);
    assert.throws(
      () => assertWorkflowTransition(status, "RUNNING"),
      /Invalid workflow transition/,
    );
  }
});

test("invalid workflow jumps are rejected", () => {
  assert.throws(
    () => assertWorkflowTransition("CREATED", "SUCCEEDED"),
    /Invalid workflow transition/,
  );
});
