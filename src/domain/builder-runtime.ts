import { sha256Json, type JsonValue } from "./stable-json.js";

export const BUILDER_INVOCATION_PLAN_SCHEMA_VERSION = "builder-invocation-plan-v1";

export const BUILDER_SIDE_EFFECT_MODES = ["NONE", "REPOSITORY_WRITE"] as const;
export type BuilderSideEffectMode = (typeof BUILDER_SIDE_EFFECT_MODES)[number];

export const BUILDER_INVOCATION_STATUSES = [
  "PREPARED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type BuilderInvocationStatus = (typeof BUILDER_INVOCATION_STATUSES)[number];

export interface BuilderExecutionLimits {
  readonly maxTurns: number;
  readonly retryBudget: number;
  readonly commandBudget: number;
  readonly timeoutSeconds: number;
}

export interface BuilderInvocationPlanContent {
  readonly schemaVersion: typeof BUILDER_INVOCATION_PLAN_SCHEMA_VERSION;
  readonly executionAttemptId: string;
  readonly taskContextPackId: string;
  readonly taskContextPackHash: string;
  readonly providerDispatchDecisionId: string;
  readonly providerKey: string;
  readonly capability: "CODE_BUILDER";
  readonly adapterKey: string;
  readonly sideEffectMode: BuilderSideEffectMode;
  readonly limits: BuilderExecutionLimits;
}

export interface BuilderAdapterInput {
  readonly invocationId: string;
  readonly planHash: string;
  readonly taskContextPackHash: string;
  readonly providerKey: string;
  readonly limits: BuilderExecutionLimits;
}

export interface BuilderAdapterResult {
  readonly outcome: "SUCCEEDED" | "FAILED";
  readonly turnsUsed: number;
  readonly commandsUsed: number;
  readonly durationMs: number;
  readonly summary: string;
  readonly evidence: JsonValue;
}

function assertIntegerRange(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
}

export function assertBuilderExecutionLimits(limits: BuilderExecutionLimits): void {
  assertIntegerRange(limits.maxTurns, "maxTurns", 1, 50);
  assertIntegerRange(limits.retryBudget, "retryBudget", 0, 10);
  assertIntegerRange(limits.commandBudget, "commandBudget", 0, 500);
  assertIntegerRange(limits.timeoutSeconds, "timeoutSeconds", 30, 7200);
}

export function assertBuilderAdapterKey(adapterKey: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(adapterKey)) {
    throw new Error(
      "adapterKey must be 2-64 lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
}

export function buildBuilderInvocationPlanContent(input: {
  readonly executionAttemptId: string;
  readonly taskContextPackId: string;
  readonly taskContextPackHash: string;
  readonly providerDispatchDecisionId: string;
  readonly providerKey: string;
  readonly adapterKey: string;
  readonly sideEffectMode: BuilderSideEffectMode;
  readonly limits: BuilderExecutionLimits;
}): BuilderInvocationPlanContent {
  assertBuilderAdapterKey(input.adapterKey);
  assertBuilderExecutionLimits(input.limits);
  if (!/^[a-f0-9]{64}$/.test(input.taskContextPackHash)) {
    throw new Error("taskContextPackHash must be a lowercase 64-character SHA-256 hash");
  }

  return {
    schemaVersion: BUILDER_INVOCATION_PLAN_SCHEMA_VERSION,
    executionAttemptId: input.executionAttemptId,
    taskContextPackId: input.taskContextPackId,
    taskContextPackHash: input.taskContextPackHash,
    providerDispatchDecisionId: input.providerDispatchDecisionId,
    providerKey: input.providerKey,
    capability: "CODE_BUILDER",
    adapterKey: input.adapterKey,
    sideEffectMode: input.sideEffectMode,
    limits: input.limits,
  };
}

export function hashBuilderInvocationPlan(
  content: BuilderInvocationPlanContent,
): string {
  return sha256Json(content as unknown as JsonValue);
}

export function assertBuilderAdapterResult(
  result: BuilderAdapterResult,
  limits: BuilderExecutionLimits,
): void {
  assertIntegerRange(result.turnsUsed, "turnsUsed", 0, limits.maxTurns);
  assertIntegerRange(result.commandsUsed, "commandsUsed", 0, limits.commandBudget);
  assertIntegerRange(result.durationMs, "durationMs", 0, limits.timeoutSeconds * 1000);
  if (result.summary.trim().length === 0) {
    throw new Error("Builder adapter result summary must not be empty");
  }
}
