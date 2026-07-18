import type { Pool } from "pg";

import { WorkspaceReadContextService } from "../services/workspace-read-context-service.js";
import { PostgresWorkspaceReadContextStore } from "../store/workspace-read-context-store.js";
import { loadRepositoryWorkspaceConfig } from "./workspace-config.js";
import { WorkspaceReadContextCapturer } from "./workspace-read-context-capturer.js";

export function createWorkspaceReadContextRuntime(pool: Pool) {
  const workspaceConfig = loadRepositoryWorkspaceConfig();
  const store = new PostgresWorkspaceReadContextStore(pool);
  const capturer = new WorkspaceReadContextCapturer(workspaceConfig.workspaceRoot);
  const service = new WorkspaceReadContextService(store, capturer);
  return { store, capturer, service };
}
