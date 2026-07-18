import assert from "node:assert/strict";
import test from "node:test";

import { sha256Json, stableStringify } from "./stable-json.js";

test("stable JSON canonicalizes object key ordering", () => {
  const first = { beta: 2, alpha: { z: true, a: null } };
  const second = { alpha: { a: null, z: true }, beta: 2 };

  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(sha256Json(first), sha256Json(second));
});

test("array ordering remains significant", () => {
  assert.notEqual(sha256Json([1, 2]), sha256Json([2, 1]));
});
