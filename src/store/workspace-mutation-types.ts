import type { WorkspaceMutationOperation } from "../domain/workspace-mutation.js";
import type { WorkspaceMutationPathEvidence } from "../repository/atomic-workspace-mutation-applier.js";
import type { Actor } from "./types.js";

export interface PrepareWorkspaceMutationInput {
  readonly repositoryWorkspaceId: string;
  readonly operations: readonly WorkspaceMutationOperation[];
  readonly actor: Actor;
}

export interface ClaimWorkspaceMutationRunResult {
  readonly claimed: boolean;
  readonly run: Record<string, unknown>;
  readonly plan: Record<string, unknown>;
}

export interface CompleteWorkspaceMutationRunInput {
  readonly workspaceMutationRunId: string;
  readonly outcome: "APPLIED" | "FAILED";
  readonly durationMs: number;
  readonly pathEvidence: readonly WorkspaceMutationPathEvidence[];
  readonly errorCode: string | null;
  readonly actor: Actor;
}

export interface WorkspaceMutationStore {
  prepareWorkspaceMutation(
    input: PrepareWorkspaceMutationInput,
  ): Promise<Record<string, unknown>>;
  claimWorkspaceMutationRun(
    workspaceMutationRunId: string,
    actor: Actor,
  ): Promise<ClaimWorkspaceMutationRunResult>;
  completeWorkspaceMutationRun(
    input: CompleteWorkspaceMutationRunInput,
  ): Promise<Record<string, unknown>>;
  getWorkspaceMutationRun(
    workspaceMutationRunId: string,
  ): Promise<Record<string, unknown> | null>;
  getProjectWorkspaceMutationStatus(projectId: string): Promise<Record<string, unknown>>;
  getPlatformWorkspaceMutationStatus(): Promise<Record<string, unknown>>;
}
