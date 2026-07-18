import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFreshness } from "./freshness-validation.js";

const validFacts = {
  projectStatus: "ACTIVE",
  taskStatus: "READY",
  contractStatus: "DRAFT",
  contractVersion: 1,
  currentContractVersion: 1,
  effectiveAuthorization: true,
} as const;

test("freshness validation accepts active current work with effective authorization evidence", () => {
  assert.deepEqual(evaluateFreshness(validFacts), {
    outcome: "VALID",
    reasonCode: "OK",
    targetStatus: "ELIGIBLE",
    waitingReason: "NONE",
  });
});

test("freshness validation blocks inactive projects and missing effective authorization", () => {
  assert.equal(
    evaluateFreshness({ ...validFacts, projectStatus: "PAUSED" }).reasonCode,
    "PROJECT_INACTIVE",
  );
  assert.deepEqual(
    evaluateFreshness({ ...validFacts, effectiveAuthorization: false }),
    {
      outcome: "BLOCKED",
      reasonCode: "CONTRACT_NOT_AUTHORIZED",
      targetStatus: "BLOCKED",
      waitingReason: "FOUNDER_DECISION",
    },
  );
});

test("mutable AUTHORIZED status cannot replace authorization evidence", () => {
  assert.equal(
    evaluateFreshness({
      ...validFacts,
      contractStatus: "AUTHORIZED",
      effectiveAuthorization: false,
    }).reasonCode,
    "CONTRACT_NOT_AUTHORIZED",
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
