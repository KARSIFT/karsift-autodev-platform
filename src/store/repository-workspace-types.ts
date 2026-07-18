import type { RepositoryWorkspaceMode } from "../domain/repository-workspace.js";
import type { RepositoryWorkspaceChange } from "../repository/repository-workspace-adapter.js";
import type { Actor } from "./types.js";

export interface PrepareRepositoryWorkspaceInput {
  readonly builderInvocationId: string;
  readonly mode: RepositoryWorkspaceMode;
  readonly actor: Actor;
}

export interface MarkRepositoryWorkspaceMaterializedInput {
  readonly repositoryWorkspaceId: string;
  readonly workspacePath: string;
  readonly headCommitSha: string;
  readonly actor: Actor;
}

export interface FinalizeRepositoryWorkspaceInput {
  readonly repositoryWorkspaceId: string;
  readonly headCommitSha: string;
  readonly changes: readonly RepositoryWorkspaceChange[];
  readonly actor: Actor;
}

export interface TransitionRepositoryWorkspaceInput {
  readonly repositoryWorkspaceId: string;
  readonly actor: Actor;
}

export interface RepositoryWorkspaceStore {
  prepareRepositoryWorkspace(
    input: PrepareRepositoryWorkspaceInput,
  ): Promise<Record<string, unknown>>;
  markRepositoryWorkspaceMaterialized(
    input: MarkRepositoryWorkspaceMaterializedInput,
  ): Promise<Record<string, unknown>>;
  finalizeRepositoryWorkspace(
    input: FinalizeRepositoryWorkspaceInput,
  ): Promise<Record<string, unknown>>;
  abandonRepositoryWorkspace(
    input: TransitionRepositoryWorkspaceInput,
  ): Promise<Record<string, unknown>>;
  failRepositoryWorkspace(
    input: TransitionRepositoryWorkspaceInput,
  ): Promise<Record<string, unknown>>;
  getRepositoryWorkspace(
    repositoryWorkspaceId: string,
  ): Promise<Record<string, unknown> | null>;
  getProjectRepositoryWorkspaceStatus(
    projectId: string,
  ): Promise<Record<string, unknown>>;
  getPlatformRepositoryWorkspaceStatus(): Promise<Record<string, unknown>>;
}
