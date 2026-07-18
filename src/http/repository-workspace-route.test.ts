import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AppConfig } from "../config.js";
import type { RepositoryWorkspaceService } from "../services/repository-workspace-service.js";
import type {
  FinalizeRepositoryWorkspaceInput,
  MarkRepositoryWorkspaceMaterializedInput,
  PrepareRepositoryWorkspaceInput,
  RepositoryWorkspaceStore,
  TransitionRepositoryWorkspaceInput,
} from "../store/repository-workspace-types.js";
import { attachRepositoryWorkspaceRoute } from "./repository-workspace-route.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 0,
  publicBaseUrl: "http://127.0.0.1",
  internalApiToken: "internal-token-that-is-at-least-32-characters",
  internalServiceId: "control-plane",
  founderApiToken: "founder-token-that-is-at-least-32-characters!",
  founderInterfaceApiToken:
    "founder-interface-token-that-is-at-least-32-characters",
  founderId: "founder-1",
  databaseUrl: "postgres://unused",
};

class FakeRepositoryWorkspaceStore implements RepositoryWorkspaceStore {
  public prepared: PrepareRepositoryWorkspaceInput[] = [];

  public async prepareRepositoryWorkspace(
    input: PrepareRepositoryWorkspaceInput,
  ): Promise<Record<string, unknown>> {
    this.prepared.push(input);
    return { workspace: { id: "workspace-1", status: "PREPARED" } };
  }

  public async markRepositoryWorkspaceMaterialized(
    _input: MarkRepositoryWorkspaceMaterializedInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async finalizeRepositoryWorkspace(
    _input: FinalizeRepositoryWorkspaceInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async abandonRepositoryWorkspace(
    _input: TransitionRepositoryWorkspaceInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async failRepositoryWorkspace(
    _input: TransitionRepositoryWorkspaceInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async getRepositoryWorkspace(
    repositoryWorkspaceId: string,
  ): Promise<Record<string, unknown> | null> {
    return repositoryWorkspaceId === "missing"
      ? null
      : { id: repositoryWorkspaceId, status: "FINALIZED" };
  }

  public async getProjectRepositoryWorkspaceStatus(): Promise<Record<string, unknown>> {
    return { repositoryWorkspaceCounts: [] };
  }

  public async getPlatformRepositoryWorkspaceStatus(): Promise<Record<string, unknown>> {
    return { repositoryWorkspaceCounts: [] };
  }
}

class FakeRepositoryWorkspaceService {
  public materialized: string[] = [];
  public finalized: string[] = [];
  public abandoned: string[] = [];

  public async materialize(input: {
    repositoryWorkspaceId: string;
    sourceRepositoryPath: string;
  }): Promise<Record<string, unknown>> {
    this.materialized.push(input.repositoryWorkspaceId);
    return { workspace: { id: input.repositoryWorkspaceId, status: "MATERIALIZED" } };
  }

  public async finalize(input: {
    repositoryWorkspaceId: string;
  }): Promise<Record<string, unknown>> {
    this.finalized.push(input.repositoryWorkspaceId);
    return { workspace: { id: input.repositoryWorkspaceId, status: "FINALIZED" } };
  }

  public async abandon(input: {
    repositoryWorkspaceId: string;
  }): Promise<Record<string, unknown>> {
    this.abandoned.push(input.repositoryWorkspaceId);
    return { id: input.repositoryWorkspaceId, status: "ABANDONED" };
  }
}

async function withServer(
  operation: (
    baseUrl: string,
    store: FakeRepositoryWorkspaceStore,
    service: FakeRepositoryWorkspaceService,
  ) => Promise<void>,
): Promise<void> {
  const store = new FakeRepositoryWorkspaceStore();
  const service = new FakeRepositoryWorkspaceService();
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  attachRepositoryWorkspaceRoute(
    server,
    config,
    store,
    service as unknown as RepositoryWorkspaceService,
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await operation(`http://127.0.0.1:${address.port}`, store, service);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("founder-facing credentials cannot prepare repository workspaces", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/builder-invocations/invocation-1/repository-workspaces`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.founderApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mode: "WRITE" }),
      },
    );
    assert.equal(response.status, 403);
    assert.equal(store.prepared.length, 0);
  });
});

test("internal service can prepare a typed workspace plan", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/builder-invocations/invocation-1/repository-workspaces`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mode: "READ_ONLY" }),
      },
    );
    assert.equal(response.status, 201);
    assert.equal(store.prepared[0]?.mode, "READ_ONLY");
    assert.equal(store.prepared[0]?.actor.type, "SYSTEM");
  });
});

test("internal service can materialize and finalize through the service boundary", async () => {
  await withServer(async (baseUrl, _store, service) => {
    const materializeResponse = await fetch(
      `${baseUrl}/v1/repository-workspaces/workspace-1/materialize`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sourceRepositoryPath: "fixture-repo" }),
      },
    );
    assert.equal(materializeResponse.status, 200);
    assert.deepEqual(service.materialized, ["workspace-1"]);

    const finalizeResponse = await fetch(
      `${baseUrl}/v1/repository-workspaces/workspace-1/finalize`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${config.internalApiToken}` },
      },
    );
    assert.equal(finalizeResponse.status, 200);
    assert.deepEqual(service.finalized, ["workspace-1"]);
  });
});
