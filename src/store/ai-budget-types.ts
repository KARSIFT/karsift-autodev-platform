import type { ExecutionClass } from "../domain/ai-budget.js";
import type { Actor } from "./types.js";

export interface UpsertAiBudgetPolicyInput {
  readonly projectId: string;
  readonly monthlyLimitMicrousd: number;
  readonly perWorkLimitMicrousd: number;
  readonly maxAiTier: 0 | 1 | 2 | 3 | 4;
  readonly enabled: boolean;
  readonly actor: Actor;
}

export interface AuthorizeWorkBudgetInput {
  readonly workQueueItemId: string;
  readonly executionClass: ExecutionClass;
  readonly estimatedMaxCostMicrousd: number;
  readonly actor: Actor;
}

export interface SettleAiBudgetReservationInput {
  readonly executionAttemptId: string;
  readonly actualCostMicrousd: number;
  readonly actor: Actor;
}

export interface AiBudgetStore {
  upsertAiBudgetPolicy(
    input: UpsertAiBudgetPolicyInput,
  ): Promise<Record<string, unknown>>;
  authorizeWorkBudget(
    input: AuthorizeWorkBudgetInput,
  ): Promise<Record<string, unknown>>;
  settleAiBudgetReservation(
    input: SettleAiBudgetReservationInput,
  ): Promise<Record<string, unknown>>;
  getProjectAiBudgetStatus(projectId: string): Promise<Record<string, unknown>>;
  getPlatformAiBudgetStatus(): Promise<Record<string, unknown>>;
}
