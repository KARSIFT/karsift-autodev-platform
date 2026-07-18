export const EXECUTION_CLASSES = [
  "DETERMINISTIC",
  "AI_TIER_1",
  "AI_TIER_2",
  "AI_TIER_3",
  "AI_TIER_4",
] as const;

export type ExecutionClass = (typeof EXECUTION_CLASSES)[number];

export type BudgetDecisionOutcome = "APPROVED" | "DENIED" | "DEFERRED";

export type BudgetDecisionReason =
  | "NO_AI_REQUIRED"
  | "BUDGET_RESERVED"
  | "BUDGET_POLICY_MISSING"
  | "BUDGET_GOVERNOR_DISABLED"
  | "EXECUTION_CLASS_NOT_ALLOWED"
  | "PER_WORK_LIMIT_EXCEEDED"
  | "PERIOD_BUDGET_EXHAUSTED";

export interface AiBudgetPolicyFacts {
  readonly enabled: boolean;
  readonly monthlyLimitMicrousd: number;
  readonly perWorkLimitMicrousd: number;
  readonly maxAiTier: 0 | 1 | 2 | 3 | 4;
}

export interface BudgetEvaluationInput {
  readonly executionClass: ExecutionClass;
  readonly estimatedMaxCostMicrousd: number;
  readonly policy: AiBudgetPolicyFacts | null;
  readonly committedAndReservedMicrousd: number;
}

export interface BudgetEvaluationDecision {
  readonly outcome: BudgetDecisionOutcome;
  readonly reason: BudgetDecisionReason;
  readonly reservationMicrousd: number;
}

export function executionClassTier(executionClass: ExecutionClass): 0 | 1 | 2 | 3 | 4 {
  if (executionClass === "DETERMINISTIC") {
    return 0;
  }
  return Number(executionClass.at(-1)) as 1 | 2 | 3 | 4;
}

export function evaluateAiBudget(
  input: BudgetEvaluationInput,
): BudgetEvaluationDecision {
  if (!Number.isSafeInteger(input.estimatedMaxCostMicrousd) || input.estimatedMaxCostMicrousd < 0) {
    throw new Error("estimatedMaxCostMicrousd must be a non-negative safe integer");
  }

  const tier = executionClassTier(input.executionClass);
  if (tier === 0) {
    if (input.estimatedMaxCostMicrousd !== 0) {
      throw new Error("DETERMINISTIC work must have zero estimated AI cost");
    }
    return {
      outcome: "APPROVED",
      reason: "NO_AI_REQUIRED",
      reservationMicrousd: 0,
    };
  }

  if (!input.policy) {
    return {
      outcome: "DENIED",
      reason: "BUDGET_POLICY_MISSING",
      reservationMicrousd: 0,
    };
  }

  if (!input.policy.enabled) {
    return {
      outcome: "DENIED",
      reason: "BUDGET_GOVERNOR_DISABLED",
      reservationMicrousd: 0,
    };
  }

  if (tier > input.policy.maxAiTier) {
    return {
      outcome: "DENIED",
      reason: "EXECUTION_CLASS_NOT_ALLOWED",
      reservationMicrousd: 0,
    };
  }

  if (input.estimatedMaxCostMicrousd > input.policy.perWorkLimitMicrousd) {
    return {
      outcome: "DENIED",
      reason: "PER_WORK_LIMIT_EXCEEDED",
      reservationMicrousd: 0,
    };
  }

  if (
    input.committedAndReservedMicrousd + input.estimatedMaxCostMicrousd >
    input.policy.monthlyLimitMicrousd
  ) {
    return {
      outcome: "DEFERRED",
      reason: "PERIOD_BUDGET_EXHAUSTED",
      reservationMicrousd: 0,
    };
  }

  return {
    outcome: "APPROVED",
    reason: "BUDGET_RESERVED",
    reservationMicrousd: input.estimatedMaxCostMicrousd,
  };
}
