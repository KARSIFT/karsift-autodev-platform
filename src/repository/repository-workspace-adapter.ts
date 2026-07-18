import type { RepositoryWorkspaceMode } from "../domain/repository-workspace.js";

export interface MaterializeRepositoryWorkspaceInput {
  readonly sourceRepositoryPath: string;
  readonly workspacePath: string;
  readonly baseCommitSha: string;
  readonly branchName: string;
  readonly mode: RepositoryWorkspaceMode;
}

export interface MaterializedRepositoryWorkspace {
  readonly workspacePath: string;
  readonly headCommitSha: string;
}

export interface RepositoryWorkspaceChange {
  readonly path: string;
  readonly status: string;
  readonly contentHash: string | null;
}

export interface RepositoryWorkspaceDiffEvidence {
  readonly headCommitSha: string;
  readonly changes: readonly RepositoryWorkspaceChange[];
}

export interface RepositoryWorkspaceAdapter {
  readonly key: string;
  materialize(
    input: MaterializeRepositoryWorkspaceInput,
  ): Promise<MaterializedRepositoryWorkspace>;
  collectDiffEvidence(workspacePath: string): Promise<RepositoryWorkspaceDiffEvidence>;
  cleanup(workspacePath: string): Promise<void>;
}

export class RepositoryWorkspaceAdapterRegistry {
  private readonly adapters = new Map<string, RepositoryWorkspaceAdapter>();

  public constructor(adapters: readonly RepositoryWorkspaceAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.key)) {
        throw new Error(`Duplicate repository workspace adapter key: ${adapter.key}`);
      }
      this.adapters.set(adapter.key, adapter);
    }
  }

  public get(adapterKey: string): RepositoryWorkspaceAdapter {
    const adapter = this.adapters.get(adapterKey);
    if (!adapter) {
      throw new Error(`Repository workspace adapter not registered: ${adapterKey}`);
    }
    return adapter;
  }
}
