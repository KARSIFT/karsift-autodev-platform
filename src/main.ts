import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createControlPlaneServer } from "./http/server.js";
import { PostgresControlPlaneStore } from "./store/postgres-store.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const store = new PostgresControlPlaneStore(pool);
const server = createControlPlaneServer(config, store);

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
