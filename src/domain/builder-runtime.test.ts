import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBuilderAdapterResult,
  assertBuilderExecutionLimits,
  buildBuilderInvocationPlanContent,
  hashBuilderInvocationPlan,
} from "./builder-runtime.js";

test("builder execution limits are bounded", () => {
  assert.doesNotThrow(() =>
    assertBuilderExecutionLimits({
      maxTurns: 12,
      retryBudget: 2,
      commandBudget: 80,
      timeoutSeconds: 900,
    }),
  );
  assert.throws(
    () =>
      assertBuilderExecutionLimits({
        maxTurns: 0,
        retryBudget: 2,
        commandBudget: 80,
        timeoutSeconds: 900,
      }),
    /maxTurns/,
  );
  assert.throws(
    () =>
      assertBuilderExecutionLimits({
        maxTurns: 12,
        retryBudget: 2,
        commandBudget: 501,
        timeoutSeconds: 900,
      }),
    /commandBudget/,
  );
});

test("builder invocation plan hashing is deterministic", () => {
  const plan = buildBuilderInvocationPlanContent({
    executionAttemptId: "attempt-1",
    taskContextPackId: "pack-1",
    taskContextPackHash: "a".repeat(64),
    providerDispatchDecisionId: "dispatch-1",
    providerKey: "dry-run-builder",
    adapterKey: "dry-run",
    sideEffectMode: "NONE",
    limits: {
      maxTurns: 1,
      retryBudget: 0,
      commandBudget: 0,
      timeoutSeconds: 30,
    },
  });

  assert.equal(hashBuilderInvocationPlan(plan), hashBuilderInvocationPlan({ ...plan }));
  assert.equal(plan.schemaVersion, "builder-invocation-plan-v1");
  assert.equal(plan.capability, "CODE_BUILDER");
});

test("adapter results cannot exceed the immutable execution limits", () => {
  const limits = {
    maxTurns: 2,
    retryBudget: 0,
    commandBudget: 3,
    timeoutSeconds: 30,
  };
  assert.doesNotThrow(() =>
    assertBuilderAdapterResult(
      {
        outcome: "SUCCEEDED",
        turnsUsed: 1,
        commandsUsed: 0,
        durationMs: 1,
        summary: "Dry run complete",
        evidence: { dryRun: true },
      },
      limits,
    ),
  );
  assert.throws(
    () =>
      assertBuilderAdapterResult(
        {
          outcome: "SUCCEEDED",
          turnsUsed: 3,
          commandsUsed: 0,
          durationMs: 1,
          summary: "Too many turns",
          evidence: {},
        },
        limits,
      ),
    /turnsUsed/,
  );
});
