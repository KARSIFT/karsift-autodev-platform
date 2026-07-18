import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

const baseEnv = {
  DATABASE_URL: "postgres://example",
  CONTROL_PLANE_API_TOKEN: "internal-token-that-is-at-least-32-characters",
  CONTROL_PLANE_FOUNDER_API_TOKEN:
    "founder-token-that-is-at-least-32-characters!",
  CONTROL_PLANE_FOUNDER_INTERFACE_API_TOKEN:
    "founder-interface-token-that-is-at-least-32-characters",
} as NodeJS.ProcessEnv;

test("configuration loads three distinct bearer credentials", () => {
  const config = loadConfig({
    ...baseEnv,
    CONTROL_PLANE_PUBLIC_BASE_URL: "https://control.example.com/",
  });

  assert.equal(config.publicBaseUrl, "https://control.example.com");
  assert.notEqual(config.internalApiToken, config.founderApiToken);
  assert.notEqual(config.internalApiToken, config.founderInterfaceApiToken);
  assert.notEqual(config.founderApiToken, config.founderInterfaceApiToken);
});

test("configuration rejects reused bearer credentials", () => {
  assert.throws(
    () =>
      loadConfig({
        ...baseEnv,
        CONTROL_PLANE_FOUNDER_INTERFACE_API_TOKEN:
          baseEnv.CONTROL_PLANE_FOUNDER_API_TOKEN,
      }),
    /must all be distinct/,
  );
});
