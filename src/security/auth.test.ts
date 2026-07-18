import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateBearerToken,
  parseBearerToken,
  secureTokenEquals,
} from "./auth.js";

const credentials = {
  internalApiToken: "internal-token-that-is-at-least-32-characters",
  internalServiceId: "control-plane",
  founderApiToken: "founder-token-that-is-at-least-32-characters!",
  founderId: "founder-1",
} as const;

test("bearer token parsing is strict", () => {
  assert.equal(parseBearerToken("Bearer secret-token"), "secret-token");
  assert.equal(parseBearerToken("bearer secret-token"), null);
  assert.equal(parseBearerToken("Bearer two tokens"), null);
  assert.equal(parseBearerToken(undefined), null);
});

test("token comparison rejects missing and unequal values", () => {
  assert.equal(secureTokenEquals(null, "expected"), false);
  assert.equal(secureTokenEquals("different", "expected"), false);
  assert.equal(secureTokenEquals("expected", "expected"), true);
});

test("founder authority cannot be asserted by caller-controlled headers", () => {
  assert.deepEqual(
    authenticateBearerToken(
      `Bearer ${credentials.founderApiToken}`,
      credentials,
    ),
    { type: "FOUNDER", id: "founder-1" },
  );

  assert.deepEqual(
    authenticateBearerToken(
      `Bearer ${credentials.internalApiToken}`,
      credentials,
    ),
    { type: "SYSTEM", id: "control-plane" },
  );

  assert.equal(
    authenticateBearerToken("Bearer invalid-token", credentials),
    null,
  );
});
