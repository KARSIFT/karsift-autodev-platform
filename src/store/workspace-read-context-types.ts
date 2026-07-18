import type { WorkspaceReadContextFile } from "../domain/workspace-read-context.js";
import type { Actor } from "./types.js";

export interface PrepareWorkspaceReadContextInput {
  readonly repositoryWorkspaceId: string;
  readonly requestedPaths: readonly string[];
  readonly actor: Actor;
}

export interface ClaimWorkspaceReadContextRunResult {
  readonly claimed: boolean;
  readonly run: Record<string, unknown>;
  readonly request: Record<string, unknown>;
}

export interface CompleteWorkspaceReadContextInput {
  readonly workspaceReadContextRunId: string;
  readonly files: readonly WorkspaceReadContextFile[];
  readonly actor: Actor;
}

export interface FailWorkspaceReadContextInput {
  readonly workspaceReadContextRunId: string;
  readonly actor: Actor;
}

export interface WorkspaceReadContextStore {
  prepareWorkspaceReadContext(
    input: PrepareWorkspaceReadContextInput,
  ): Promise<Record<string, unknown>>;
  claimWorkspaceReadContextRun(
    workspaceReadContextRunId: string,
    actor: Actor,
  ): Promise<ClaimWorkspaceReadContextRunResult>;
  completeWorkspaceReadContext(
    input: CompleteWorkspaceReadContextInput,
  ): Promise<Record<string, unknown>>;
  failWorkspaceReadContext(
    input: FailWorkspaceReadContextInput,
  ): Promise<Record<string, unknown>>;
  getWorkspaceReadContextRun(
    workspaceReadContextRunId: string,
  ): Promise<Record<string, unknown> | null>;
  getProjectWorkspaceReadContextStatus(projectId: string): Promise<Record<string, unknown>>;
  getPlatformWorkspaceReadContextStatus(): Promise<Record<string, unknown>>;
}
