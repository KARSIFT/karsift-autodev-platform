import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AppConfig } from "../config.js";
import type { WorkspaceReadContextService } from "../services/workspace-read-context-service.js";
import type {
  ClaimWorkspaceReadContextRunResult,
  CompleteWorkspaceReadContextInput,
  FailWorkspaceReadContextInput,
  PrepareWorkspaceReadContextInput,
  WorkspaceReadContextStore,
} from "../store/workspace-read-context-types.js";
import type { Actor } from "../store/types.js";
import { attachWorkspaceReadContextRoute } from "./workspace-read-context-route.js";

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

class FakeStore implements WorkspaceReadContextStore {
  public prepared: PrepareWorkspaceReadContextInput[] = [];
  public async prepareWorkspaceReadContext(
    input: PrepareWorkspaceReadContextInput,
  ): Promise<Record<string, unknown>> {
    this.prepared.push(input);
    return { run: { id: "read-run-1", status: "PREPARED" } };
  }
  public async claimWorkspaceReadContextRun(
    _id: string,
    _actor: Actor,
  ): Promise<ClaimWorkspaceReadContextRunResult> {
    return { claimed: false, run: {}, request: {} };
  }
  public async completeWorkspaceReadContext(
    _input: CompleteWorkspaceReadContextInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }
  public async failWorkspaceReadContext(
    _input: FailWorkspaceReadContextInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }
  public async getWorkspaceReadContextRun(id: string): Promise<Record<string, unknown> | null> {
    return id === "missing" ? null : { id, status: "CAPTURED" };
  }
  public async getProjectWorkspaceReadContextStatus(): Promise<Record<string, unknown>> {
    return { workspaceReadContextCounts: [] };
  }
  public async getPlatformWorkspaceReadContextStatus(): Promise<Record<string, unknown>> {
    return { workspaceReadContextCounts: [] };
  }
}

class FakeService {
  public captured: string[] = [];
  public async capture(input: { workspaceReadContextRunId: string }): Promise<Record<string, unknown>> {
    this.captured.push(input.workspaceReadContextRunId);
    return { id: input.workspaceReadContextRunId, status: "CAPTURED" };
  }
}

async function withServer(
  operation: (baseUrl: string, store: FakeStore, service: FakeService) => Promise<void>,
): Promise<void> {
  const store = new FakeStore();
  const service = new FakeService();
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  attachWorkspaceReadContextRoute(
    server,
    config,
    store,
    service as unknown as WorkspaceReadContextService,
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

test("founder credentials cannot prepare workspace read contexts", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(`${baseUrl}/v1/repository-workspaces/ws-1/read-contexts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.founderApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestedPaths: ["src"] }),
    });
    assert.equal(response.status, 403);
    assert.equal(store.prepared.length, 0);
  });
});

test("internal service can prepare and capture a bounded read context", async () => {
  await withServer(async (baseUrl, store, service) => {
    const prepare = await fetch(`${baseUrl}/v1/repository-workspaces/ws-1/read-contexts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.internalApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestedPaths: ["src"] }),
    });
    assert.equal(prepare.status, 201);
    assert.deepEqual(store.prepared[0]?.requestedPaths, ["src"]);

    const capture = await fetch(`${baseUrl}/v1/workspace-read-context-runs/read-run-1/capture`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.internalApiToken}` },
    });
    assert.equal(capture.status, 200);
    assert.deepEqual(service.captured, ["read-run-1"]);
  });
});
