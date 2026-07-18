import assert from "node:assert/strict";
import test from "node:test";

import {
  canChangeEligibility,
  isExecutionPolicy,
  isWaitingReason,
  targetEligibilityState,
} from "./work-queue.js";

test("work queue enums preserve distinct policy and waiting semantics", () => {
  assert.equal(isExecutionPolicy("IMMEDIATE"), true);
  assert.equal(isExecutionPolicy("QUOTA"), false);
  assert.equal(isWaitingReason("QUOTA"), true);
  assert.equal(isWaitingReason("IMMEDIATE"), false);
});

test("eligibility transitions require coherent waiting reasons", () => {
  assert.deepEqual(targetEligibilityState(true, "NONE"), {
    status: "ELIGIBLE",
    waitingReason: "NONE",
  });
  assert.deepEqual(targetEligibilityState(false, "BUDGET"), {
    status: "BLOCKED",
    waitingReason: "BUDGET",
  });
  assert.throws(() => targetEligibilityState(true, "BUDGET"));
  assert.throws(() => targetEligibilityState(false, "NONE"));
});

test("active and terminal work cannot be reclassified through eligibility", () => {
  assert.equal(canChangeEligibility("QUEUED"), true);
  assert.equal(canChangeEligibility("BLOCKED"), true);
  assert.equal(canChangeEligibility("RUNNING"), false);
  assert.equal(canChangeEligibility("COMPLETED"), false);
});
