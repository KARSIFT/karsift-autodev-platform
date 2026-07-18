import type { Pool } from "pg";

import { BuilderProposalAdapterRegistry } from "./builder-proposal-adapter.js";
import { FixtureBuilderProposalAdapter } from "./fixture-builder-proposal-adapter.js";
import { BuilderProposalService } from "../services/builder-proposal-service.js";
import { PostgresBuilderProposalStore } from "../store/builder-proposal-store.js";
import type { BuilderDispatchStore } from "../store/builder-runtime-types.js";

export function createBuilderProposalRuntime(
  pool: Pool,
  dispatchStore: BuilderDispatchStore,
) {
  const store = new PostgresBuilderProposalStore(pool);
  const adapters = new BuilderProposalAdapterRegistry([
    new FixtureBuilderProposalAdapter(),
  ]);
  const service = new BuilderProposalService(store, dispatchStore, adapters);
  return { store, adapters, service };
}
