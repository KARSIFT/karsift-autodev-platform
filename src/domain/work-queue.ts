export const WORK_QUEUE_STATUSES = [
  "QUEUED",
  "ELIGIBLE",
  "DISPATCHED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "BLOCKED",
  "SUPERSEDED",
] as const;

export type WorkQueueStatus = (typeof WORK_QUEUE_STATUSES)[number];

export const EXECUTION_POLICIES = [
  "IMMEDIATE",
  "WHEN_AI_CAPACITY_AVAILABLE",
  "SCHEDULED",
] as const;

export type ExecutionPolicy = (typeof EXECUTION_POLICIES)[number];

export const WAITING_REASONS = [
  "NONE",
  "QUOTA",
  "BUDGET",
  "DEPENDENCY",
  "FOUNDER_DECISION",
  "EXTERNAL_SYSTEM",
  "PROVIDER_UNAVAILABLE",
  "POLICY",
] as const;

export type WaitingReason = (typeof WAITING_REASONS)[number];

export const EXECUTION_ATTEMPT_STATUSES = [
  "ACTIVE",
  "SUCCEEDED",
  "FAILED",
  "RELEASED",
  "EXPIRED",
] as const;

export type ExecutionAttemptStatus =
  (typeof EXECUTION_ATTEMPT_STATUSES)[number];

export function isExecutionPolicy(value: string): value is ExecutionPolicy {
  return EXECUTION_POLICIES.includes(value as ExecutionPolicy);
}

export function isWaitingReason(value: string): value is WaitingReason {
  return WAITING_REASONS.includes(value as WaitingReason);
}

export function canChangeEligibility(status: WorkQueueStatus): boolean {
  return status === "QUEUED" || status === "ELIGIBLE" || status === "BLOCKED";
}

export function targetEligibilityState(
  eligible: boolean,
  waitingReason: WaitingReason,
): { readonly status: "ELIGIBLE" | "BLOCKED"; readonly waitingReason: WaitingReason } {
  if (eligible) {
    if (waitingReason !== "NONE") {
      throw new Error("Eligible work must use waiting reason NONE");
    }
    return { status: "ELIGIBLE", waitingReason: "NONE" };
  }

  if (waitingReason === "NONE") {
    throw new Error("Blocked work requires a non-NONE waiting reason");
  }

  return { status: "BLOCKED", waitingReason };
}
