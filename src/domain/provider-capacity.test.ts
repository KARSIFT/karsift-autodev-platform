import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProviderKey,
  evaluateProviderDispatchReadiness,
  evaluateProviderRoute,
  normalizeProviderKeys,
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

test("routing falls through to the first healthy provider", () => {
  assert.deepEqual(
    evaluateProviderRoute([
      {
        providerKey: "primary-builder",
        rank: 1,
        capacity: { status: "QUOTA_EXHAUSTED", fresh: true },
      },
      {
        providerKey: "fallback-builder",
        rank: 2,
        capacity: { status: "HEALTHY", fresh: true },
      },
    ]),
    {
      outcome: "READY",
      waitingReason: "NONE",
      reason: "PROVIDER_READY",
      providerKey: "fallback-builder",
      providerRank: 2,
    },
  );
});

test("routing preserves the primary wait reason when no provider is ready", () => {
  assert.deepEqual(
    evaluateProviderRoute([
      {
        providerKey: "primary-builder",
        rank: 1,
        capacity: { status: "QUOTA_EXHAUSTED", fresh: true },
      },
      {
        providerKey: "fallback-builder",
        rank: 2,
        capacity: { status: "UNAVAILABLE", fresh: true },
      },
    ]),
    {
      outcome: "WAIT",
      waitingReason: "QUOTA",
      reason: "PROVIDER_QUOTA_EXHAUSTED",
      providerKey: "primary-builder",
      providerRank: 1,
    },
  );
});

test("missing routing policy is an explicit unavailable wait", () => {
  assert.deepEqual(evaluateProviderRoute([]), {
    outcome: "WAIT",
    waitingReason: "PROVIDER_UNAVAILABLE",
    reason: "PROVIDER_ROUTING_POLICY_MISSING",
    providerKey: null,
    providerRank: null,
  });
});

test("provider keys and route lists are bounded machine identifiers", () => {
  assert.doesNotThrow(() => assertProviderKey("openai-codex"));
  assert.throws(() => assertProviderKey("OpenAI Codex"), /providerKey/);
  assert.throws(() => assertProviderKey("x"), /providerKey/);
  assert.deepEqual(normalizeProviderKeys(["primary-builder", "fallback-builder"]), [
    "primary-builder",
    "fallback-builder",
  ]);
  assert.throws(
    () => normalizeProviderKeys(["primary-builder", "primary-builder"]),
    /duplicates/,
  );
  assert.throws(() => normalizeProviderKeys([]), /between 1 and 10/);
});
