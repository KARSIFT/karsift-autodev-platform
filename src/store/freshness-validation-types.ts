import type { Actor } from "./types.js";

export interface ValidateWorkQueueItemInput {
  readonly workQueueItemId: string;
  readonly actor: Actor;
}

export interface FreshnessValidationStore {
  validateWorkQueueItem(
    input: ValidateWorkQueueItemInput,
  ): Promise<Record<string, unknown>>;
  getProjectValidationStatus(projectId: string): Promise<Record<string, unknown>>;
  getPlatformValidationStatus(): Promise<Record<string, unknown>>;
}
