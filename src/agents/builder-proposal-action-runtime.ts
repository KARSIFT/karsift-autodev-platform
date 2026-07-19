import type { Pool } from "pg";

import { BuilderProposalActionService } from "../services/builder-proposal-action-service.js";
import { PostgresBuilderProposalActionStore } from "../store/builder-proposal-action-store.js";
import type { WorkspaceCommandStore } from "../store/workspace-command-types.js";
import type { WorkspaceMutationStore } from "../store/workspace-mutation-types.js";
import type { WorkspaceReadContextStore } from "../store/workspace-read-context-types.js";

export function createBuilderProposalActionRuntime(
  pool: Pool,
  commandStore: WorkspaceCommandStore,
  mutationStore: WorkspaceMutationStore,
  readContextStore: WorkspaceReadContextStore,
) {
  const store = new PostgresBuilderProposalActionStore(pool);
  const service = new BuilderProposalActionService(
    store,
    commandStore,
    mutationStore,
    readContextStore,
  );
  return { store, service };
}
