import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAiBudget } from "./ai-budget.js";

const policy = {
  enabled: true,
  monthlyLimitMicrousd: 10_000_000,
  perWorkLimitMicrousd: 2_000_000,
  maxAiTier: 3 as const,
};

test("deterministic work is explicitly approved at zero AI cost", () => {
  assert.deepEqual(
    evaluateAiBudget({
      executionClass: "DETERMINISTIC",
      estimatedMaxCostMicrousd: 0,
      policy: null,
      committedAndReservedMicrousd: 0,
    }),
    {
      outcome: "APPROVED",
      reason: "NO_AI_REQUIRED",
      reservationMicrousd: 0,
    },
  );
});

test("AI work requires an enabled policy and an allowed tier", () => {
  assert.equal(
    evaluateAiBudget({
      executionClass: "AI_TIER_1",
      estimatedMaxCostMicrousd: 100,
      policy: null,
      committedAndReservedMicrousd: 0,
    }).reason,
    "BUDGET_POLICY_MISSING",
  );
  assert.equal(
    evaluateAiBudget({
      executionClass: "AI_TIER_4",
      estimatedMaxCostMicrousd: 100,
      policy,
      committedAndReservedMicrousd: 0,
    }).reason,
    "EXECUTION_CLASS_NOT_ALLOWED",
  );
});

test("per-work and monthly limits are distinguished", () => {
  assert.equal(
    evaluateAiBudget({
      executionClass: "AI_TIER_2",
      estimatedMaxCostMicrousd: 2_000_001,
      policy,
      committedAndReservedMicrousd: 0,
    }).reason,
    "PER_WORK_LIMIT_EXCEEDED",
  );
  assert.deepEqual(
    evaluateAiBudget({
      executionClass: "AI_TIER_2",
      estimatedMaxCostMicrousd: 1_000_000,
      policy,
      committedAndReservedMicrousd: 9_500_000,
    }),
    {
      outcome: "DEFERRED",
      reason: "PERIOD_BUDGET_EXHAUSTED",
      reservationMicrousd: 0,
    },
  );
});

test("approved AI work reserves the maximum authorized cost", () => {
  assert.deepEqual(
    evaluateAiBudget({
      executionClass: "AI_TIER_3",
      estimatedMaxCostMicrousd: 1_500_000,
      policy,
      committedAndReservedMicrousd: 1_000_000,
    }),
    {
      outcome: "APPROVED",
      reason: "BUDGET_RESERVED",
      reservationMicrousd: 1_500_000,
    },
  );
});
