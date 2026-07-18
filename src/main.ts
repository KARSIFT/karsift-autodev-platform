import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { attachAiBudgetRoute } from "./http/ai-budget-route.js";
import { attachContractAuthorizationRoute } from "./http/contract-authorization-route.js";
import { attachProviderDispatchRoute } from "./http/provider-dispatch-route.js";
import { createControlPlaneServer } from "./http/server.js";
import { attachTaskContextPackRoute } from "./http/task-context-pack-route.js";
import { ExtendedPostgresControlPlaneStore } from "./store/extended-postgres-store.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const store = new ExtendedPostgresControlPlaneStore(pool);
const server = createControlPlaneServer(config, store);
attachContractAuthorizationRoute(server, config, store);
attachAiBudgetRoute(server, config, store);
attachProviderDispatchRoute(server, config, store);
attachTaskContextPackRoute(server, config, store);

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
