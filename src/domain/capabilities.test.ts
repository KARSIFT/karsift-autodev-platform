import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCapability,
  assertCapabilityEnablementAllowed,
  CAPABILITIES,
} from "./capabilities.js";

test("all ADP-002 autonomous capabilities remain non-enableable", () => {
  for (const capability of CAPABILITIES) {
    assert.throws(
      () => assertCapabilityEnablementAllowed(capability, true),
      /disabled at activation level A1/,
    );
    assert.doesNotThrow(() =>
      assertCapabilityEnablementAllowed(capability, false),
    );
  }
});

test("unknown capability names are rejected", () => {
  assert.throws(() => assertCapability("ROOT_ACCESS"), /Unknown capability/);
});
