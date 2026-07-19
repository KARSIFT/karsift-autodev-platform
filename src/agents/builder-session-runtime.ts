import type { Pool } from "pg";

import type { BuilderProposalAdapterRegistry } from "./builder-proposal-adapter.js";
import { BuilderSessionExecutionService } from "../services/builder-session-execution-service.js";
import { BuilderSessionProposalService } from "../services/builder-session-proposal-service.js";
import { BuilderSessionService } from "../services/builder-session-service.js";
import { BuilderSessionTerminationService } from "../services/builder-session-termination-service.js";
import { GovernedBuilderSessionService } from "../services/governed-builder-session-service.js";
import type { BuilderProposalActionService } from "../services/builder-proposal-action-service.js";
import type { WorkspaceCommandService } from "../services/workspace-command-service.js";
import type { WorkspaceMutationService } from "../services/workspace-mutation-service.js";
import type { WorkspaceReadContextService } from "../services/workspace-read-context-service.js";
import { PostgresBuilderSessionStore } from "../store/builder-session-store.js";
import type { BuilderProposalStore } from "../store/builder-proposal-types.js";
import type { BuilderDispatchStore } from "../store/builder-runtime-types.js";
import type { WorkQueueStore } from "../store/work-queue-types.js";
import type { WorkspaceCommandStore } from "../store/workspace-command-types.js";
import type { WorkspaceMutationStore } from "../store/workspace-mutation-types.js";
import type { WorkspaceReadContextStore } from "../store/workspace-read-context-types.js";

export function createBuilderSessionRuntime(input: {
  readonly pool: Pool;
  readonly proposalStore: BuilderProposalStore;
  readonly proposalAdapters: BuilderProposalAdapterRegistry;
  readonly dispatchStore: BuilderDispatchStore;
  readonly workQueueStore: WorkQueueStore;
  readonly actionService: BuilderProposalActionService;
  readonly commandStore: WorkspaceCommandStore;
  readonly commandService: WorkspaceCommandService;
  readonly mutationStore: WorkspaceMutationStore;
  readonly mutationService: WorkspaceMutationService;
  readonly readContextStore: WorkspaceReadContextStore;
  readonly readContextService: WorkspaceReadContextService;
}) {
  const store = new PostgresBuilderSessionStore(input.pool);
  const proposalService = new BuilderSessionProposalService(
    input.pool,
    input.proposalStore,
    input.dispatchStore,
    input.proposalAdapters,
  );
  const executionService = new BuilderSessionExecutionService(
    input.pool,
    input.workQueueStore,
  );
  const terminationService = new BuilderSessionTerminationService(
    input.pool,
    proposalService,
    executionService,
  );
  const stepService = new BuilderSessionService(
    store,
    input.proposalStore,
    proposalService,
    input.actionService,
    input.commandStore,
    input.commandService,
    input.mutationStore,
    input.mutationService,
    input.readContextStore,
    input.readContextService,
  );
  const service = new GovernedBuilderSessionService(
    stepService,
    terminationService,
    executionService,
  );
  return {
    store,
    service,
    proposalService,
    executionService,
    terminationService,
  };
}
