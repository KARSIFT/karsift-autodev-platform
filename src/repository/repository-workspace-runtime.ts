import type { Pool } from "pg";

import { RepositoryWorkspaceService } from "../services/repository-workspace-service.js";
import { PostgresRepositoryWorkspaceStore } from "../store/repository-workspace-store.js";
import { LocalGitWorkspaceAdapter } from "./local-git-workspace-adapter.js";
import { RepositoryWorkspaceAdapterRegistry } from "./repository-workspace-adapter.js";
import { loadRepositoryWorkspaceConfig } from "./workspace-config.js";

export function createRepositoryWorkspaceRuntime(pool: Pool) {
  const config = loadRepositoryWorkspaceConfig();
  const store = new PostgresRepositoryWorkspaceStore(pool);
  const adapters = new RepositoryWorkspaceAdapterRegistry([
    new LocalGitWorkspaceAdapter(config),
  ]);
  const service = new RepositoryWorkspaceService(store, adapters, config);
  return { config, store, service };
}
