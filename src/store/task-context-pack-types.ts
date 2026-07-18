import type { Actor } from "./types.js";

export interface CreateTaskContextPackInput {
  readonly executionAttemptId: string;
  readonly leaseToken: string;
  readonly baseBranch: string;
  readonly baseCommitSha: string;
  readonly relevantPaths: readonly string[];
  readonly actor: Actor;
}

export interface TaskContextPackStore {
  createTaskContextPack(
    input: CreateTaskContextPackInput,
  ): Promise<Record<string, unknown>>;
  getTaskContextPack(
    executionAttemptId: string,
  ): Promise<Record<string, unknown> | null>;
  getProjectTaskContextPackStatus(
    projectId: string,
  ): Promise<Record<string, unknown>>;
  getPlatformTaskContextPackStatus(): Promise<Record<string, unknown>>;
}
