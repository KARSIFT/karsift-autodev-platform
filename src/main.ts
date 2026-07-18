import { BuilderAdapterRegistry } from "./agents/builder-adapter.js";
import { createBuilderProposalRuntime } from "./agents/builder-proposal-runtime.js";
import { DryRunBuilderAdapter } from "./agents/dry-run-builder-adapter.js";
import { createWorkspaceCommandRuntime } from "./commands/workspace-command-runtime.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { attachAiBudgetRoute } from "./http/ai-budget-route.js";
import { attachBuilderProposalRoute } from "./http/builder-proposal-route.js";
import { attachBuilderRuntimeRoute } from "./http/builder-runtime-route.js";
import { attachContractAuthorizationRoute } from "./http/contract-authorization-route.js";
import { attachProviderDispatchRoute } from "./http/provider-dispatch-route.js";
import { attachRepositoryWorkspaceRoute } from "./http/repository-workspace-route.js";
import { createControlPlaneServer } from "./http/server.js";
import { attachTaskContextPackRoute } from "./http/task-context-pack-route.js";
import { attachWorkspaceCommandRoute } from "./http/workspace-command-route.js";
import { attachWorkspaceMutationRoute } from "./http/workspace-mutation-route.js";
import { attachWorkspaceReadContextRoute } from "./http/workspace-read-context-route.js";
import { createRepositoryWorkspaceRuntime } from "./repository/repository-workspace-runtime.js";
import { createWorkspaceMutationRuntime } from "./repository/workspace-mutation-runtime.js";
import { createWorkspaceReadContextRuntime } from "./repository/workspace-read-context-runtime.js";
import { BuilderRuntimeService } from "./services/builder-runtime-service.js";
import { ExtendedPostgresControlPlaneStore } from "./store/extended-postgres-store.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const store = new ExtendedPostgresControlPlaneStore(pool);
const builderAdapters = new BuilderAdapterRegistry([new DryRunBuilderAdapter()]);
const builderRuntimeService = new BuilderRuntimeService(
  store,
  store,
  builderAdapters,
);
const repositoryWorkspaceRuntime = createRepositoryWorkspaceRuntime(pool);
const workspaceCommandRuntime = createWorkspaceCommandRuntime(pool);
const workspaceMutationRuntime = createWorkspaceMutationRuntime(pool);
const workspaceReadContextRuntime = createWorkspaceReadContextRuntime(pool);
const builderProposalRuntime = createBuilderProposalRuntime(pool, store);
const server = createControlPlaneServer(config, store);
attachContractAuthorizationRoute(server, config, store);
attachAiBudgetRoute(server, config, store);
attachProviderDispatchRoute(server, config, store);
attachTaskContextPackRoute(server, config, store);
attachBuilderRuntimeRoute(server, config, store, builderRuntimeService);
attachRepositoryWorkspaceRoute(
  server,
  config,
  repositoryWorkspaceRuntime.store,
  repositoryWorkspaceRuntime.service,
);
attachWorkspaceCommandRoute(
  server,
  config,
  workspaceCommandRuntime.store,
  workspaceCommandRuntime.service,
);
attachWorkspaceMutationRoute(
  server,
  config,
  workspaceMutationRuntime.store,
  workspaceMutationRuntime.service,
);
attachWorkspaceReadContextRoute(
  server,
  config,
  workspaceReadContextRuntime.store,
  workspaceReadContextRuntime.service,
);
attachBuilderProposalRoute(
  server,
  config,
  builderProposalRuntime.store,
  builderProposalRuntime.service,
);

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

server.listen(config.port, config.host, () => {
  console.log(
    `KARSIFT Control Plane listening on http://${config.host}:${config.port}`,
  );
});
