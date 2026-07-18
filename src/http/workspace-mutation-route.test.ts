import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AppConfig } from "../config.js";
import type { WorkspaceMutationService } from "../services/workspace-mutation-service.js";
import type {
  ClaimWorkspaceMutationRunResult,
  CompleteWorkspaceMutationRunInput,
  PrepareWorkspaceMutationInput,
  WorkspaceMutationStore,
} from "../store/workspace-mutation-types.js";
import type { Actor } from "../store/types.js";
import { attachWorkspaceMutationRoute } from "./workspace-mutation-route.js";

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

class FakeWorkspaceMutationStore implements WorkspaceMutationStore {
  public prepared: PrepareWorkspaceMutationInput[] = [];

  public async prepareWorkspaceMutation(
    input: PrepareWorkspaceMutationInput,
  ): Promise<Record<string, unknown>> {
    this.prepared.push(input);
    return { run: { id: "mutation-run-1", status: "PREPARED" } };
  }

  public async claimWorkspaceMutationRun(
    _workspaceMutationRunId: string,
    _actor: Actor,
  ): Promise<ClaimWorkspaceMutationRunResult> {
    return { claimed: false, run: {}, plan: {} };
  }

  public async completeWorkspaceMutationRun(
    _input: CompleteWorkspaceMutationRunInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async getWorkspaceMutationRun(
    workspaceMutationRunId: string,
  ): Promise<Record<string, unknown> | null> {
    return workspaceMutationRunId === "missing"
      ? null
      : { id: workspaceMutationRunId, status: "APPLIED" };
  }

  public async getProjectWorkspaceMutationStatus(): Promise<Record<string, unknown>> {
    return { workspaceMutationCounts: [] };
  }

  public async getPlatformWorkspaceMutationStatus(): Promise<Record<string, unknown>> {
    return { workspaceMutationCounts: [] };
  }
}

class FakeWorkspaceMutationService {
  public runIds: string[] = [];

  public async apply(input: {
    workspaceMutationRunId: string;
  }): Promise<Record<string, unknown>> {
    this.runIds.push(input.workspaceMutationRunId);
    return { id: input.workspaceMutationRunId, status: "APPLIED" };
  }
}

async function withServer(
  operation: (
    baseUrl: string,
    store: FakeWorkspaceMutationStore,
    service: FakeWorkspaceMutationService,
  ) => Promise<void>,
): Promise<void> {
  const store = new FakeWorkspaceMutationStore();
  const service = new FakeWorkspaceMutationService();
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  attachWorkspaceMutationRoute(
    server,
    config,
    store,
    service as unknown as WorkspaceMutationService,
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

test("founder credentials cannot prepare workspace mutations", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/repository-workspaces/workspace-1/mutations`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.founderApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operations: [] }),
      },
    );
    assert.equal(response.status, 403);
    assert.equal(store.prepared.length, 0);
  });
});

test("internal service can prepare structured mutation operations", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/repository-workspaces/workspace-1/mutations`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operations: [
            {
              type: "CREATE",
              path: "src/new.ts",
              expectedBeforeHash: null,
              content: "export const value = 1;\n",
            },
          ],
        }),
      },
    );
    assert.equal(response.status, 201);
    assert.equal(store.prepared[0]?.repositoryWorkspaceId, "workspace-1");
    assert.equal(store.prepared[0]?.operations[0]?.type, "CREATE");
  });
});

test("internal service can apply a prepared mutation run", async () => {
  await withServer(async (baseUrl, _store, service) => {
    const response = await fetch(
      `${baseUrl}/v1/workspace-mutation-runs/mutation-run-1/apply`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${config.internalApiToken}` },
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(service.runIds, ["mutation-run-1"]);
  });
});
