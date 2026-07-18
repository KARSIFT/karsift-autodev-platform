import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFreshness } from "./freshness-validation.js";

const validFacts = {
  projectStatus: "ACTIVE",
  taskStatus: "READY",
  contractStatus: "AUTHORIZED",
  contractVersion: 1,
  currentContractVersion: 1,
} as const;

test("freshness validation accepts only active current authorized work", () => {
  assert.deepEqual(evaluateFreshness(validFacts), {
    outcome: "VALID",
    reasonCode: "OK",
    targetStatus: "ELIGIBLE",
    waitingReason: "NONE",
  });
});

test("freshness validation blocks inactive projects and unauthorized contracts", () => {
  assert.equal(
    evaluateFreshness({ ...validFacts, projectStatus: "PAUSED" }).reasonCode,
    "PROJECT_INACTIVE",
  );
  assert.deepEqual(
    evaluateFreshness({ ...validFacts, contractStatus: "DRAFT" }),
    {
      outcome: "BLOCKED",
      reasonCode: "CONTRACT_NOT_AUTHORIZED",
      targetStatus: "BLOCKED",
      waitingReason: "FOUNDER_DECISION",
    },
  );
});

test("freshness validation distinguishes stale and superseded work", () => {
  assert.equal(
    evaluateFreshness({ ...validFacts, currentContractVersion: 2 }).outcome,
    "STALE",
  );
  assert.equal(
    evaluateFreshness({ ...validFacts, contractStatus: "CANCELLED" }).outcome,
    "SUPERSEDED",
  );
  assert.equal(
    evaluateFreshness({ ...validFacts, taskStatus: "COMPLETED" }).outcome,
    "SUPERSEDED",
  );
});
