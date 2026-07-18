import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateContractAuthorization,
  extractContractGovernanceFacts,
} from "./contract-authorization.js";

const baseFacts = {
  riskLevel: "R2" as const,
  founderApprovalRequired: false,
  ehrRequired: false,
  strengthenedGatesSatisfied: false,
  protectedTechnicalWork: false,
};

test("R0-R2 work may be authorized by the system when no founder condition applies", () => {
  assert.deepEqual(evaluateContractAuthorization(baseFacts, "SYSTEM"), {
    authorized: true,
    reason: "AUTHORIZED_BY_POLICY",
    requiredAuthority: "SYSTEM_OR_FOUNDER",
  });
});

test("R3 system authorization requires strengthened gates", () => {
  assert.equal(
    evaluateContractAuthorization(
      { ...baseFacts, riskLevel: "R3" },
      "SYSTEM",
    ).authorized,
    false,
  );
  assert.equal(
    evaluateContractAuthorization(
      { ...baseFacts, riskLevel: "R3", strengthenedGatesSatisfied: true },
      "SYSTEM",
    ).authorized,
    true,
  );
});

test("R4 and explicit founder/EHR conditions require founder authority", () => {
  for (const facts of [
    { ...baseFacts, riskLevel: "R4" as const },
    { ...baseFacts, founderApprovalRequired: true },
    { ...baseFacts, ehrRequired: true },
  ]) {
    assert.equal(evaluateContractAuthorization(facts, "SYSTEM").authorized, false);
    assert.equal(evaluateContractAuthorization(facts, "FOUNDER").authorized, true);
  }
});

test("governance facts must come from an explicit immutable governance block", () => {
  assert.deepEqual(
    extractContractGovernanceFacts({
      objective: "test",
      governance: {
        riskLevel: "R3",
        founderApprovalRequired: false,
        ehrRequired: false,
        strengthenedGatesSatisfied: true,
        protectedTechnicalWork: true,
      },
    }),
    {
      riskLevel: "R3",
      founderApprovalRequired: false,
      ehrRequired: false,
      strengthenedGatesSatisfied: true,
      protectedTechnicalWork: true,
    },
  );

  assert.throws(
    () => extractContractGovernanceFacts({ objective: "missing governance" }),
    /governance/,
  );
});
