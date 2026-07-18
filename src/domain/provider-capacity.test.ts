import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProviderKey,
  evaluateProviderDispatchReadiness,
} from "./provider-capacity.js";

test("missing and stale provider observations wait as provider unavailable", () => {
  assert.deepEqual(evaluateProviderDispatchReadiness(null), {
    outcome: "WAIT",
    waitingReason: "PROVIDER_UNAVAILABLE",
    reason: "PROVIDER_OBSERVATION_MISSING",
  });
  assert.equal(
    evaluateProviderDispatchReadiness({ status: "HEALTHY", fresh: false }).reason,
    "PROVIDER_OBSERVATION_STALE",
  );
});

test("healthy provider capacity is READY", () => {
  assert.deepEqual(
    evaluateProviderDispatchReadiness({ status: "HEALTHY", fresh: true }),
    {
      outcome: "READY",
      waitingReason: "NONE",
      reason: "PROVIDER_READY",
    },
  );
});

test("quota exhaustion is distinct from provider unavailability", () => {
  assert.deepEqual(
    evaluateProviderDispatchReadiness({
      status: "QUOTA_EXHAUSTED",
      fresh: true,
    }),
    {
      outcome: "WAIT",
      waitingReason: "QUOTA",
      reason: "PROVIDER_QUOTA_EXHAUSTED",
    },
  );
  assert.equal(
    evaluateProviderDispatchReadiness({ status: "UNAVAILABLE", fresh: true })
      .waitingReason,
    "PROVIDER_UNAVAILABLE",
  );
});

test("provider keys are bounded machine identifiers", () => {
  assert.doesNotThrow(() => assertProviderKey("openai-codex"));
  assert.throws(() => assertProviderKey("OpenAI Codex"), /providerKey/);
  assert.throws(() => assertProviderKey("x"), /providerKey/);
});
