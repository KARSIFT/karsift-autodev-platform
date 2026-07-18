import assert from "node:assert/strict";
import test from "node:test";

import { isFounderInterfaceRouteAllowed } from "./authorization.js";

const founderInterface = {
  type: "FOUNDER",
  id: "founder-1",
  credentialKind: "FOUNDER_INTERFACE",
} as const;

const founder = {
  type: "FOUNDER",
  id: "founder-1",
  credentialKind: "FOUNDER",
} as const;

test("founder interface permits only status reads and request creation", () => {
  assert.equal(isFounderInterfaceRouteAllowed(founderInterface, "GET", "/v1/status"), true);
  assert.equal(
    isFounderInterfaceRouteAllowed(
      founderInterface,
      "GET",
      "/v1/projects/project-1/status",
    ),
    true,
  );
  assert.equal(
    isFounderInterfaceRouteAllowed(
      founderInterface,
      "POST",
      "/v1/projects/project-1/requests",
    ),
    true,
  );

  const forbidden = [
    ["POST", "/v1/projects"],
    ["POST", "/v1/projects/project-1/decisions"],
    ["POST", "/v1/projects/project-1/change-contracts"],
    ["POST", "/v1/change-contracts/contract-1/versions"],
    ["POST", "/v1/projects/project-1/tasks"],
    ["POST", "/v1/projects/project-1/workflow-runs"],
    ["POST", "/v1/workflow-runs/run-1/transition"],
    ["POST", "/v1/capabilities/AI_DISPATCH/disable"],
  ] as const;

  for (const [method, path] of forbidden) {
    assert.equal(isFounderInterfaceRouteAllowed(founderInterface, method, path), false);
  }
});

test("higher-authority credentials retain existing route access", () => {
  assert.equal(
    isFounderInterfaceRouteAllowed(founder, "POST", "/v1/projects/project-1/decisions"),
    true,
  );
});
