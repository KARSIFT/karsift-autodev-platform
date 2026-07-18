import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createFounderOpenApiDocument } from "./founder-openapi.js";

test("founder OpenAPI exposes only the least-privilege action surface", () => {
  const document = createFounderOpenApiDocument("https://control.example.com");
  assert.deepEqual(document.servers, [{ url: "https://control.example.com" }]);
  assert.deepEqual(Object.keys(document.paths).sort(), [
    "/v1/projects/{projectId}/requests",
    "/v1/projects/{projectId}/status",
    "/v1/status",
  ]);
  assert.equal("/v1/projects" in document.paths, false);
  assert.equal("/v1/capabilities/{capability}/disable" in document.paths, false);
});

test("checked-in GPT Action schema matches the runtime schema", async () => {
  const checkedIn = JSON.parse(
    await readFile("openapi/founder-actions.json", "utf8"),
  ) as Record<string, unknown>;
  const runtime = createFounderOpenApiDocument(
    "https://control-plane.example.com",
  );

  assert.deepEqual(checkedIn, runtime);
});
