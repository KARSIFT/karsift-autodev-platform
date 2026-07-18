import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDispatchLeaseSeconds,
  builderDispatchIdempotencyKey,
  evaluateLatestBuilderProviderReadiness,
} from "./builder-dispatch.js";

test("builder dispatch idempotency key is stable for one immutable plan", () => {
  const planHash = "a".repeat(64);
  assert.equal(
    builderDispatchIdempotencyKey(planHash),
    `builder-dispatch:${planHash}`,
  );
  assert.throws(() => builderDispatchIdempotencyKey("bad"), /planHash/);
});

test("latest provider readiness preserves quota and unavailable semantics", () => {
  assert.deepEqual(
    evaluateLatestBuilderProviderReadiness({
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
    evaluateLatestBuilderProviderReadiness({
      status: "UNAVAILABLE",
      fresh: true,
    }).waitingReason,
    "PROVIDER_UNAVAILABLE",
  );
  assert.equal(
    evaluateLatestBuilderProviderReadiness({ status: "HEALTHY", fresh: true })
      .outcome,
    "READY",
  );
});

test("dispatch claim lease duration is bounded", () => {
  assert.doesNotThrow(() => assertDispatchLeaseSeconds(300));
  assert.throws(() => assertDispatchLeaseSeconds(29), /leaseSeconds/);
  assert.throws(() => assertDispatchLeaseSeconds(3601), /leaseSeconds/);
});
