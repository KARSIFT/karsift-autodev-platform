import type { JsonValue } from "../domain/stable-json.js";
import type {
  ExecutionPolicy,
  WaitingReason,
} from "../domain/work-queue.js";
import type { Actor } from "./types.js";

export interface CreateWorkQueueItemInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly executionPolicy: ExecutionPolicy;
  readonly scheduledFor: string | null;
  readonly idempotencyKey: string;
  readonly actor: Actor;
}

export interface SetWorkQueueEligibilityInput {
  readonly workQueueItemId: string;
  readonly expectedStateVersion: number;
  readonly eligible: boolean;
  readonly waitingReason: WaitingReason;
  readonly actor: Actor;
}

export interface ClaimExecutionLeaseInput {
  readonly projectId: string | null;
  readonly leaseOwner: string;
  readonly leaseSeconds: number;
  readonly actor: Actor;
}

export interface HeartbeatExecutionLeaseInput {
  readonly executionAttemptId: string;
  readonly leaseToken: string;
  readonly leaseSeconds: number;
  readonly actor: Actor;
}

export interface CompleteExecutionLeaseInput {
  readonly executionAttemptId: string;
  readonly leaseToken: string;
  readonly outcome: "SUCCEEDED" | "FAILED";
  readonly details: JsonValue;
  readonly actor: Actor;
}

export interface ReleaseExecutionLeaseInput {
  readonly executionAttemptId: string;
  readonly leaseToken: string;
  readonly waitingReason: WaitingReason;
  readonly actor: Actor;
}

export interface WorkQueueStore {
  createWorkQueueItem(
    input: CreateWorkQueueItemInput,
  ): Promise<Record<string, unknown>>;
  setWorkQueueEligibility(
    input: SetWorkQueueEligibilityInput,
  ): Promise<Record<string, unknown>>;
  claimExecutionLease(
    input: ClaimExecutionLeaseInput,
  ): Promise<Record<string, unknown> | null>;
  heartbeatExecutionLease(
    input: HeartbeatExecutionLeaseInput,
  ): Promise<Record<string, unknown>>;
  completeExecutionLease(
    input: CompleteExecutionLeaseInput,
  ): Promise<Record<string, unknown>>;
  releaseExecutionLease(
    input: ReleaseExecutionLeaseInput,
  ): Promise<Record<string, unknown>>;
  getProjectQueueStatus(projectId: string): Promise<Record<string, unknown>>;
  getPlatformQueueStatus(): Promise<Record<string, unknown>>;
}
