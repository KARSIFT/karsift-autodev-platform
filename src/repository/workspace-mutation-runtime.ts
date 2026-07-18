import type { Pool } from "pg";

import { WorkspaceMutationService } from "../services/workspace-mutation-service.js";
import { PostgresWorkspaceMutationStore } from "../store/workspace-mutation-store.js";
import { AtomicWorkspaceMutationApplier } from "./atomic-workspace-mutation-applier.js";
import { loadRepositoryWorkspaceConfig } from "./workspace-config.js";

export function createWorkspaceMutationRuntime(pool: Pool) {
  const workspaceConfig = loadRepositoryWorkspaceConfig();
  const store = new PostgresWorkspaceMutationStore(pool);
  const applier = new AtomicWorkspaceMutationApplier(workspaceConfig.workspaceRoot);
  const service = new WorkspaceMutationService(store, applier);
  return { store, applier, service };
}
