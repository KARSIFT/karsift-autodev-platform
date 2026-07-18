import type { WaitingReason, WorkQueueStatus } from "./work-queue.js";

export const VALIDATION_OUTCOMES = [
  "VALID",
  "BLOCKED",
  "STALE",
  "SUPERSEDED",
] as const;

export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number];

export const VALIDATION_REASON_CODES = [
  "OK",
  "PROJECT_INACTIVE",
  "TASK_NOT_EXECUTABLE",
  "CONTRACT_NOT_AUTHORIZED",
  "CONTRACT_VERSION_STALE",
  "CONTRACT_TERMINATED",
] as const;

export type ValidationReasonCode = (typeof VALIDATION_REASON_CODES)[number];

export interface FreshnessFacts {
  readonly projectStatus: "ACTIVE" | "PAUSED" | "ARCHIVED";
  readonly taskStatus:
    | "QUEUED"
    | "BLOCKED"
    | "READY"
    | "RUNNING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELLED";
  readonly contractStatus: "DRAFT" | "AUTHORIZED" | "SUPERSEDED" | "CANCELLED";
  readonly contractVersion: number;
  readonly currentContractVersion: number;
  readonly effectiveAuthorization: boolean;
}

export interface FreshnessDecision {
  readonly outcome: ValidationOutcome;
  readonly reasonCode: ValidationReasonCode;
  readonly targetStatus: WorkQueueStatus;
  readonly waitingReason: WaitingReason;
}

export function evaluateFreshness(facts: FreshnessFacts): FreshnessDecision {
  if (facts.projectStatus !== "ACTIVE") {
    return {
      outcome: "BLOCKED",
      reasonCode: "PROJECT_INACTIVE",
      targetStatus: "BLOCKED",
      waitingReason: "POLICY",
    };
  }

  if (["COMPLETED", "FAILED", "CANCELLED"].includes(facts.taskStatus)) {
    return {
      outcome: "SUPERSEDED",
      reasonCode: "TASK_NOT_EXECUTABLE",
      targetStatus: "SUPERSEDED",
      waitingReason: "NONE",
    };
  }

  if (facts.taskStatus === "RUNNING") {
    return {
      outcome: "BLOCKED",
      reasonCode: "TASK_NOT_EXECUTABLE",
      targetStatus: "BLOCKED",
      waitingReason: "POLICY",
    };
  }

  if (facts.contractStatus === "SUPERSEDED" || facts.contractStatus === "CANCELLED") {
    return {
      outcome: "SUPERSEDED",
      reasonCode: "CONTRACT_TERMINATED",
      targetStatus: "SUPERSEDED",
      waitingReason: "NONE",
    };
  }

  if (facts.contractVersion !== facts.currentContractVersion) {
    return {
      outcome: "STALE",
      reasonCode: "CONTRACT_VERSION_STALE",
      targetStatus: "BLOCKED",
      waitingReason: "POLICY",
    };
  }

  if (!facts.effectiveAuthorization) {
    return {
      outcome: "BLOCKED",
      reasonCode: "CONTRACT_NOT_AUTHORIZED",
      targetStatus: "BLOCKED",
      waitingReason: "FOUNDER_DECISION",
    };
  }

  return {
    outcome: "VALID",
    reasonCode: "OK",
    targetStatus: "ELIGIBLE",
    waitingReason: "NONE",
  };
}
