import { sha256Json, type JsonValue } from "./stable-json.js";

export const BUILDER_SESSION_STATUSES = [
  "PREPARED",
  "READY_FOR_TURN",
  "WAITING_ACTION",
  "REFRESH_CONTEXT",
  "WAITING_REFRESH_CONTEXT",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
] as const;
export type BuilderSessionStatus = (typeof BUILDER_SESSION_STATUSES)[number];

export const BUILDER_SESSION_TERMINAL_STATUSES = [
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
] as const;
export type BuilderSessionTerminalStatus =
  (typeof BUILDER_SESSION_TERMINAL_STATUSES)[number];

export const BUILDER_SESSION_STEP_OPERATIONS = [
  "START_SESSION",
  "PREPARE_PROPOSAL",
  "GENERATE_PROPOSAL",
  "MATERIALIZE_ACTION",
  "EXECUTE_CONTEXT_CAPTURE",
  "EXECUTE_COMMAND",
  "EXECUTE_MUTATION",
  "RECONCILE_ACTION",
  "PREPARE_REFRESH_CONTEXT",
  "CAPTURE_REFRESH_CONTEXT",
  "ADVANCE_AFTER_ACTION",
  "FINALIZE_COMPLETE",
  "FINALIZE_BLOCKED",
  "FAIL_STALE_AUTHORITY",
  "CANCEL_SESSION",
] as const;
export type BuilderSessionStepOperation =
  (typeof BUILDER_SESSION_STEP_OPERATIONS)[number];

export interface BuilderSessionPlanContentInput {
  readonly projectId: string;
  readonly builderInvocationId: string;
  readonly builderInvocationPlanId: string;
  readonly builderPlanHash: string;
  readonly executionAttemptId: string;
  readonly taskContextPackId: string;
  readonly taskContextPackHash: string;
  readonly repositoryWorkspaceId: string;
  readonly repositoryWorkspacePlanId: string;
  readonly initialReadContextRunId: string;
  readonly maxTurns: number;
}

export interface BuilderSessionTerminalEvidenceInput {
  readonly outcome: BuilderSessionTerminalStatus;
  readonly turnCount: number;
  readonly finalActionEvidenceId: string | null;
  readonly finalActionEvidenceHash: string | null;
  readonly summary: string;
}

function assertHash(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 hash`);
  }
}

export function buildBuilderSessionPlanContent(
  input: BuilderSessionPlanContentInput,
): JsonValue {
  assertHash(input.builderPlanHash, "builderPlanHash");
  assertHash(input.taskContextPackHash, "taskContextPackHash");
  if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1) {
    throw new Error("maxTurns must be a positive integer");
  }
  return {
    projectId: input.projectId,
    builderInvocationId: input.builderInvocationId,
    builderInvocationPlanId: input.builderInvocationPlanId,
    builderPlanHash: input.builderPlanHash,
    executionAttemptId: input.executionAttemptId,
    taskContextPackId: input.taskContextPackId,
    taskContextPackHash: input.taskContextPackHash,
    repositoryWorkspaceId: input.repositoryWorkspaceId,
    repositoryWorkspacePlanId: input.repositoryWorkspacePlanId,
    initialReadContextRunId: input.initialReadContextRunId,
    maxTurns: input.maxTurns,
  };
}

export function hashBuilderSessionPlan(
  input: BuilderSessionPlanContentInput,
): string {
  return sha256Json(buildBuilderSessionPlanContent(input));
}

export function buildBuilderSessionTerminalEvidenceContent(
  input: BuilderSessionTerminalEvidenceInput,
): JsonValue {
  if (!BUILDER_SESSION_TERMINAL_STATUSES.includes(input.outcome)) {
    throw new Error(`unsupported builder session terminal outcome: ${input.outcome}`);
  }
  if (!Number.isInteger(input.turnCount) || input.turnCount < 0) {
    throw new Error("turnCount must be a non-negative integer");
  }
  if ((input.finalActionEvidenceId === null) !== (input.finalActionEvidenceHash === null)) {
    throw new Error(
      "final action evidence id and hash must either both be present or both be null",
    );
  }
  if (input.finalActionEvidenceHash !== null) {
    assertHash(input.finalActionEvidenceHash, "finalActionEvidenceHash");
  }
  const summary = input.summary.trim();
  if (summary.length === 0 || summary.length > 4_000) {
    throw new Error("summary must contain 1-4000 characters");
  }
  if (
    (input.outcome === "COMPLETED" || input.outcome === "BLOCKED") &&
    input.finalActionEvidenceId === null
  ) {
    throw new Error("completed or blocked sessions require final action evidence");
  }
  return {
    outcome: input.outcome,
    turnCount: input.turnCount,
    finalActionEvidenceId: input.finalActionEvidenceId,
    finalActionEvidenceHash: input.finalActionEvidenceHash,
    summary,
  };
}

export function hashBuilderSessionTerminalEvidence(
  input: BuilderSessionTerminalEvidenceInput,
): string {
  return sha256Json(buildBuilderSessionTerminalEvidenceContent(input));
}

export function isBuilderSessionTerminal(status: BuilderSessionStatus): boolean {
  return BUILDER_SESSION_TERMINAL_STATUSES.includes(
    status as BuilderSessionTerminalStatus,
  );
}
