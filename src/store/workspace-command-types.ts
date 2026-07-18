import type {
  WorkspaceCommandPolicySnapshot,
  WorkspaceCommandPurpose,
} from "../domain/workspace-command.js";
import type { WorkspaceCommandRunnerResult } from "../commands/bounded-workspace-command-runner.js";
import type { Actor } from "./types.js";

export interface CreateWorkspaceCommandPolicyInput {
  readonly projectId: string;
  readonly policyKey: string;
  readonly version: number;
  readonly enabled: boolean;
  readonly policy: WorkspaceCommandPolicySnapshot;
  readonly actor: Actor;
}

export interface PrepareWorkspaceCommandInput {
  readonly repositoryWorkspaceId: string;
  readonly policyKey: string;
  readonly purpose: WorkspaceCommandPurpose;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly actor: Actor;
}

export interface ClaimWorkspaceCommandRunResult {
  readonly claimed: boolean;
  readonly run: Record<string, unknown>;
  readonly plan: Record<string, unknown>;
}

export interface CompleteWorkspaceCommandRunInput {
  readonly workspaceCommandRunId: string;
  readonly runnerResult: WorkspaceCommandRunnerResult;
  readonly actor: Actor;
}

export interface WorkspaceCommandStore {
  createWorkspaceCommandPolicy(
    input: CreateWorkspaceCommandPolicyInput,
  ): Promise<Record<string, unknown>>;
  prepareWorkspaceCommand(
    input: PrepareWorkspaceCommandInput,
  ): Promise<Record<string, unknown>>;
  claimWorkspaceCommandRun(
    workspaceCommandRunId: string,
    actor: Actor,
  ): Promise<ClaimWorkspaceCommandRunResult>;
  completeWorkspaceCommandRun(
    input: CompleteWorkspaceCommandRunInput,
  ): Promise<Record<string, unknown>>;
  getWorkspaceCommandRun(
    workspaceCommandRunId: string,
  ): Promise<Record<string, unknown> | null>;
  getProjectWorkspaceCommandStatus(projectId: string): Promise<Record<string, unknown>>;
  getPlatformWorkspaceCommandStatus(): Promise<Record<string, unknown>>;
}
