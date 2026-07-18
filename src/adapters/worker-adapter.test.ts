import assert from "node:assert/strict";
import test from "node:test";

import { WORKER_DISPATCH_ACTIVE } from "./worker-adapter.js";

test("worker dispatch remains inactive at A1", () => {
  assert.equal(WORKER_DISPATCH_ACTIVE, false);
});
