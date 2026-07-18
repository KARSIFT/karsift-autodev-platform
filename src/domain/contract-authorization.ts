import type { JsonValue } from "./stable-json.js";

export const CONTRACT_AUTHORIZATION_POLICY_VERSION = "karsift-contract-authorization-v1";

export const RISK_LEVELS = ["R0", "R1", "R2", "R3", "R4"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export type AuthorizationActorType = "FOUNDER" | "SYSTEM";

export interface ContractGovernanceFacts {
  readonly riskLevel: RiskLevel;
  readonly founderApprovalRequired: boolean;
  readonly ehrRequired: boolean;
  readonly strengthenedGatesSatisfied: boolean;
  readonly protectedTechnicalWork: boolean;
}

export type AuthorizationPolicyReason =
  | "AUTHORIZED_BY_POLICY"
  | "FOUNDER_AUTHORITY_REQUIRED"
  | "R3_STRENGTHENED_GATES_REQUIRED";

export interface AuthorizationPolicyDecision {
  readonly authorized: boolean;
  readonly reason: AuthorizationPolicyReason;
  readonly requiredAuthority: "SYSTEM_OR_FOUNDER" | "FOUNDER";
}

function isObject(
  value: JsonValue | undefined,
): value is { [key: string]: JsonValue } {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function requiredBoolean(
  object: { [key: string]: JsonValue },
  key: string,
): boolean {
  const value = object[key];
  if (typeof value !== "boolean") {
    throw new Error(`Change Contract governance.${key} must be a boolean`);
  }
  return value;
}

export function extractContractGovernanceFacts(
  content: JsonValue,
): ContractGovernanceFacts {
  if (!isObject(content)) {
    throw new Error("Change Contract content must be an object");
  }

  const governance = content.governance;
  if (!isObject(governance)) {
    throw new Error("Change Contract content.governance must be an object");
  }

  const riskLevel = governance.riskLevel;
  if (typeof riskLevel !== "string" || !RISK_LEVELS.includes(riskLevel as RiskLevel)) {
    throw new Error("Change Contract governance.riskLevel must be R0, R1, R2, R3, or R4");
  }

  return {
    riskLevel: riskLevel as RiskLevel,
    founderApprovalRequired: requiredBoolean(governance, "founderApprovalRequired"),
    ehrRequired: requiredBoolean(governance, "ehrRequired"),
    strengthenedGatesSatisfied: requiredBoolean(
      governance,
      "strengthenedGatesSatisfied",
    ),
    protectedTechnicalWork: requiredBoolean(governance, "protectedTechnicalWork"),
  };
}

export function evaluateContractAuthorization(
  facts: ContractGovernanceFacts,
  actorType: AuthorizationActorType,
): AuthorizationPolicyDecision {
  const founderOnly =
    facts.riskLevel === "R4" ||
    facts.founderApprovalRequired ||
    facts.ehrRequired;

  if (founderOnly && actorType !== "FOUNDER") {
    return {
      authorized: false,
      reason: "FOUNDER_AUTHORITY_REQUIRED",
      requiredAuthority: "FOUNDER",
    };
  }

  if (
    facts.riskLevel === "R3" &&
    actorType !== "FOUNDER" &&
    !facts.strengthenedGatesSatisfied
  ) {
    return {
      authorized: false,
      reason: "R3_STRENGTHENED_GATES_REQUIRED",
      requiredAuthority: "SYSTEM_OR_FOUNDER",
    };
  }

  return {
    authorized: true,
    reason: "AUTHORIZED_BY_POLICY",
    requiredAuthority: founderOnly ? "FOUNDER" : "SYSTEM_OR_FOUNDER",
  };
}
