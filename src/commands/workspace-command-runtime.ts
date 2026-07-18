import type { Pool } from "pg";

import { WorkspaceCommandService } from "../services/workspace-command-service.js";
import { PostgresWorkspaceCommandStore } from "../store/workspace-command-store.js";
import { loadRepositoryWorkspaceConfig } from "../repository/workspace-config.js";
import { BoundedWorkspaceCommandRunner } from "./bounded-workspace-command-runner.js";

export function createWorkspaceCommandRuntime(pool: Pool) {
  const workspaceConfig = loadRepositoryWorkspaceConfig();
  const store = new PostgresWorkspaceCommandStore(pool);
  const runner = new BoundedWorkspaceCommandRunner(workspaceConfig.workspaceRoot);
  const service = new WorkspaceCommandService(store, runner);
  return { store, runner, service };
}
