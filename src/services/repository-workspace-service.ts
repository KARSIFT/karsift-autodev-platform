import path from "node:path";

import { RepositoryWorkspaceAdapterRegistry } from "../repository/repository-workspace-adapter.js";
import type { RepositoryWorkspaceConfig } from "../repository/workspace-config.js";
import type { RepositoryWorkspaceStore } from "../store/repository-workspace-types.js";
import type { Actor } from "../store/types.js";

interface WorkspacePlanView {
  readonly adapter_key: string;
  readonly workspace_key: string;
  readonly branch_name: string;
  readonly base_branch: string;
  readonly base_commit_sha: string;
  readonly mode: "READ_ONLY" | "WRITE";
}

interface WorkspaceView {
  readonly id: string;
  readonly status: string;
  readonly workspace_path: string | null;
  readonly plan: WorkspacePlanView;
}

function asWorkspaceView(value: Record<string, unknown>): WorkspaceView {
  return value as unknown as WorkspaceView;
}

export class RepositoryWorkspaceService {
  public constructor(
    private readonly store: RepositoryWorkspaceStore,
    private readonly adapters: RepositoryWorkspaceAdapterRegistry,
    private readonly config: RepositoryWorkspaceConfig,
  ) {}

  public async materialize(input: {
    readonly repositoryWorkspaceId: string;
    readonly sourceRepositoryPath: string;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    const currentRecord = await this.store.getRepositoryWorkspace(
      input.repositoryWorkspaceId,
    );
    if (!currentRecord) {
      throw new Error(
        `Repository workspace not found: ${input.repositoryWorkspaceId}`,
      );
    }
    const current = asWorkspaceView(currentRecord);
    if (current.status === "MATERIALIZED") {
      return currentRecord;
    }
    if (current.status !== "PREPARED") {
      throw new Error(
        `Repository workspace conflict: status ${current.status} cannot materialize`,
      );
    }

    const adapter = this.adapters.get(current.plan.adapter_key);
    const workspacePath = path.join(
      this.config.workspaceRoot,
      current.plan.workspace_key,
    );

    try {
      const materialized = await adapter.materialize({
        sourceRepositoryPath: input.sourceRepositoryPath,
        workspacePath,
        baseBranch: current.plan.base_branch,
        baseCommitSha: current.plan.base_commit_sha,
        branchName: current.plan.branch_name,
        mode: current.plan.mode,
      });
      const workspace = await this.store.markRepositoryWorkspaceMaterialized({
        repositoryWorkspaceId: input.repositoryWorkspaceId,
        workspacePath: materialized.workspacePath,
        headCommitSha: materialized.headCommitSha,
        actor: input.actor,
      });
      return { workspace, plan: current.plan };
    } catch (error) {
      await adapter.cleanup(workspacePath).catch(() => undefined);
      await this.store
        .failRepositoryWorkspace({
          repositoryWorkspaceId: input.repositoryWorkspaceId,
          actor: input.actor,
        })
        .catch(() => undefined);
      throw error;
    }
  }

  public async finalize(input: {
    readonly repositoryWorkspaceId: string;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    const currentRecord = await this.store.getRepositoryWorkspace(
      input.repositoryWorkspaceId,
    );
    if (!currentRecord) {
      throw new Error(
        `Repository workspace not found: ${input.repositoryWorkspaceId}`,
      );
    }
    const current = asWorkspaceView(currentRecord);
    if (current.status !== "MATERIALIZED" || !current.workspace_path) {
      throw new Error(
        `Repository workspace conflict: status ${current.status} cannot finalize`,
      );
    }

    const adapter = this.adapters.get(current.plan.adapter_key);
    const diffEvidence = await adapter.collectDiffEvidence(current.workspace_path);
    const finalized = await this.store.finalizeRepositoryWorkspace({
      repositoryWorkspaceId: input.repositoryWorkspaceId,
      headCommitSha: diffEvidence.headCommitSha,
      changes: diffEvidence.changes,
      actor: input.actor,
    });

    await adapter.cleanup(current.workspace_path);
    return finalized;
  }

  public async abandon(input: {
    readonly repositoryWorkspaceId: string;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    const currentRecord = await this.store.getRepositoryWorkspace(
      input.repositoryWorkspaceId,
    );
    if (!currentRecord) {
      throw new Error(
        `Repository workspace not found: ${input.repositoryWorkspaceId}`,
      );
    }
    const current = asWorkspaceView(currentRecord);
    const adapter = this.adapters.get(current.plan.adapter_key);
    if (current.workspace_path) {
      await adapter.cleanup(current.workspace_path);
    }
    return await this.store.abandonRepositoryWorkspace({
      repositoryWorkspaceId: input.repositoryWorkspaceId,
      actor: input.actor,
    });
  }
}
